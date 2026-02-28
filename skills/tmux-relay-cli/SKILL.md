# Skill: tmux-relay

## What it does

`tmux-relay` is a small CLI that acts as the last-mile bridge between a Lobster approval gate and a Claude Code session running inside tmux. When Claude Code pauses and presents numbered options to the user, Lobster notifies the user (via Discord, Telegram, etc.) and waits for their reply. That reply — either a number like `"2"` or free text like `"skip this step"` — gets piped into `tmux-relay`, which translates it into the exact key sequences needed to operate Claude Code's interactive prompt and sends them to the right tmux pane. The result is a structured JSON object you can inspect or pass downstream.

---

## When to use it

Use `tmux-relay` when:
- A Claude Code session in tmux is paused, waiting for the user to select a numbered option or enter free text.
- A Lobster workflow has collected the user's reply from a notification channel and needs to route it back to the tmux session.
- You want to drive a tmux session programmatically from a script or workflow step without writing tmux key-send logic yourself.

---

## Installation

```bash
cd ~/projects/tmux-relay-cli
npm install -g .
```

Verify:

```bash
tmux-relay --session test --reply "1" --dry-run
```

---

## Lobster pipeline usage

Include `tmux-relay` as the `route_input` step in your `.lobster` workflow, right after the approval/notification step returns the user's reply:

```yaml
steps:
  - name: notify_and_wait
    # ... sends notification, waits for reply, sets approval_payload

  - name: route_input
    run: |
      echo '{{ approval_payload | tojson }}' | tmux-relay
    on_error: fail
```

`approval_payload` must be a JSON object with at least `reply` and `session`. Example value:

```json
{
  "reply": "2",
  "options": ["Trust and proceed", "Abort", "Show diff"],
  "session": "claude-nomads",
  "socket": "/tmp/clawdbot-tmux-sockets/clawdbot.sock"
}
```

---

## Input JSON schema

Send JSON on stdin. All fields except `reply` and `session` are optional.

```json
{
  "reply":   "2",
  "session": "claude-nomads",
  "options": ["Trust and proceed", "Abort", "Show diff", "Open editor"],
  "socket":  "/tmp/clawdbot-tmux-sockets/clawdbot.sock",
  "pane":    "0.0",
  "delayMs": 200,
  "dryRun":  false
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `reply` | **Yes** | — | The user's reply — a number string or free text |
| `session` | **Yes** | — | The tmux session name to target |
| `options` | No | — | Array of option labels; enables out-of-range validation and `optionText` in output |
| `socket` | No | `/tmp/clawdbot-tmux-sockets/clawdbot.sock` | Path to the tmux server socket (`-S` flag) |
| `pane` | No | `0.0` | Pane target as `<window>.<pane>` (e.g. `0.0` = window 0, pane 0) |
| `delayMs` | No | `200` | Milliseconds to wait between each key send (prevents dropped keys) |
| `dryRun` | No | `false` | Return the key plan as JSON without actually calling tmux |

If stdin is not valid JSON, the raw string is treated as the `reply` value. Use `--session` via flag in that case.

---

## Output JSON schema

### Success — option mode

```json
{
  "ok": true,
  "mode": "option",
  "optionIndex": 1,
  "optionText": "Abort",
  "keysSent": ["Down", "Enter"],
  "session": "claude-nomads",
  "pane": "claude-nomads:0.0"
}
```

- `optionIndex` — zero-based index of the selected option
- `optionText` — the option label (present only when `options` was provided)
- `keysSent` — the logical sequence of keys sent to tmux

### Success — text mode

```json
{
  "ok": true,
  "mode": "text",
  "text": "fix the imports",
  "keysSent": ["C-u", "fix the imports", "Enter"],
  "session": "claude-nomads",
  "pane": "claude-nomads:0.0"
}
```

### Error

```json
{
  "ok": false,
  "error": "tmux session not found: claude-nomads",
  "session": "claude-nomads"
}
```

All errors are also written to stderr as plain text. Exit code is `1` on error, `0` on success.

---

## Reply routing rules

**The routing decision is made on the `reply` field after trimming whitespace:**

### Option mode — `reply` is a pure integer string

Examples: `"1"`, `"2"`, `"  3  "`

- Interpretation: user wants option N (1-based)
- Internal index: `N - 1` (0-based)
- Claude Code starts with option 1 already highlighted, so:
  - Option 1 → send `Enter` only (0 Down presses)
  - Option 2 → send `Down` once, then `Enter`
  - Option 3 → send `Down` twice, then `Enter`
  - Option N → send `Down` (N-1) times, then `Enter`
- If `options` array is provided and index is out of range → error, nothing sent

### Text mode — `reply` is anything else

Examples: `"skip this step"`, `"y"`, `"yes please"`, `"fix the imports"`

- Sends `Ctrl-U` to clear any existing input in the pane
- Sends the text literally (using `-l` flag to prevent tmux key binding interpretation)
- Sends `Enter` to submit

---

## Critical implementation rules

1. **Always use `-l` for literal text.** The tmux `send-keys -l` flag sends text literally. Without it, special characters (e.g. `$`, `!`, `;`) are interpreted as tmux key names and corrupt the input.

2. **Down key navigation is 0-indexed relative to option 1.** Option 1 is already selected; option 2 requires exactly 1 `Down` press. Never send any `Down` for option 1.

3. **Add `delayMs` between each key send.** Default 200ms. Without delays, tmux can drop keys, especially for rapid sequences. The 100ms sleep between C-u and literal text is hardcoded.

4. **Socket path is required for Lobster.** The clawdbot tmux server runs on a custom socket. Always include `socket: "/tmp/clawdbot-tmux-sockets/clawdbot.sock"` in the payload when operating inside the Lobster/clawdbot environment.

5. **Pane target format is `<window>.<pane>`.** The default `0.0` means window 0, pane 0. Do not include the session name in `pane`; the tool builds the full target as `session:pane` internally.

---

## Hook-based notification architecture

### Overview

Instead of polling tmux to detect when Claude Code is waiting, this system uses Claude Code's built-in `Notification` hook with `idle_prompt` / `elicitation_dialog` / `permission_prompt` matchers. The hook fires **instantly** when Claude Code needs input — zero polling, zero tokens, zero delay.

```
Claude Code pauses
      │
      ▼ (fires immediately)
~/.claude/hooks/openclaw-notify.js
      │  reads stdin JSON from Claude Code
      │  derives session name from cwd
      │  writes /tmp/pending-relay-<session>.json
      │
      ▼
openclaw system event --mode now --text "claude-relay-pending ..."
      │
      ▼
MAIN agent wakes up
      │  reads state file
      │  captures tmux pane for full context
      │  sends Discord notification to Trevor
      │
      ▼
Trevor replies → tmux-relay routes reply back to Claude Code
```

### Installing the hook

```bash
cd ~/projects/tmux-relay-cli
npm run install-hook
```

This copies `hooks/openclaw-notify.js` to `~/.claude/hooks/` and registers it in `~/.claude/settings.json`. Non-destructive — appends to existing Notification hooks rather than overwriting.

### What openclaw-notify.js does

1. Reads the Claude Code notification JSON from stdin
2. Checks `notification_type` — only acts on `idle_prompt`, `elicitation_dialog`, `permission_prompt`; exits silently for everything else
3. Derives the tmux session name: `claude-<project-folder-name>` (e.g. `/Users/clawd/projects/nomads-ops-center` → `claude-nomads-ops-center`)
4. Writes a state file to `/tmp/pending-relay-<session>.json`
5. Calls `openclaw system event --mode now` to immediately wake MAIN

### Input JSON from Claude Code (stdin)

```json
{
  "session_id": "abc123",
  "hook_event_name": "Notification",
  "notification_type": "idle_prompt",
  "message": "Claude is waiting for input",
  "cwd": "/Users/clawd/projects/nomads-ops-center",
  "transcript_path": "/path/to/transcript.jsonl"
}
```

### State file schema

Written to `/tmp/pending-relay-<session>.json`:

```json
{
  "session": "claude-nomads-ops-center",
  "socket": "/tmp/clawdbot-tmux-sockets/clawdbot.sock",
  "pane": "0.0",
  "notificationType": "idle_prompt",
  "message": "Claude is waiting for input",
  "claudeSessionId": "abc123",
  "cwd": "/Users/clawd/projects/nomads-ops-center",
  "timestamp": 1709123456789
}
```

### settings.json hook registration

The installer adds this entry under `hooks.Notification`:

```json
{
  "matcher": "idle_prompt|elicitation_dialog|permission_prompt",
  "hooks": [
    {
      "type": "command",
      "command": "node /Users/clawd/.claude/hooks/openclaw-notify.js"
    }
  ]
}
```

---

## Natural Language Intent Resolution

When Trevor replies in a Discord thread with natural language (not a bare number or slash command), MAIN reads the current pane content and maps the reply to the right command before routing.

### Resolution rules

| Trevor says | Resolves to |
|-------------|-------------|
| Bare number: `"1"`, `"2"`, `"3"` | Used as-is — sends that many Down presses + Enter |
| Slash command: `/gsd:plan-phase 1` | Used as-is — sent as literal text |
| `"yes"` / `"continue"` / `"proceed"` / `"ok"` / `"go"` / `"go ahead"` | Option 1 (or Enter if only one option) |
| `"no"` / `"abort"` / `"stop"` / `"cancel"` / `"skip"` | Whichever option matches cancel/no/abort/skip in the pane |
| `"discuss"` / `"talk through"` / `"before planning"` | Whichever option matches discuss/review/before |
| `"just build it"` / `"do it"` / `"just do it"` | Option 1 (proceed) |
| Anything else (free text) | Sent literally with C-u + text + Enter |

### Resolution process

1. **Capture the pane** to get the exact question and option list currently showing
2. **Classify the reply:**
   - Pure integer string → option mode (no LLM needed)
   - Starts with `/` → slash command (no LLM needed)
   - Otherwise → fuzzy match against option labels in pane
3. **Fuzzy match** — find the option whose label most closely matches the intent
4. **Fallback** — if no option matches, send as free text
5. **Confirm** — always tell Trevor what was actually sent, especially when natural language was interpreted

### When unsure

If the intent is genuinely ambiguous (multiple plausible options, none clearly matching):
- Send the best guess
- Clearly state what you sent and why
- Example: `✅ Sent option 2 ("No, skip context") — interpreted "skip" as the skip option`

---

## Discord Channel Configuration

### Changing the channel ID

By default the hook sends to the channel hardcoded in `hooks/openclaw-notify.js`:

```js
const DISCORD_CHANNEL = '1476953824911425617'; // #dev-4
```

To change it:

1. Edit `~/projects/tmux-relay-cli/hooks/openclaw-notify.js`
2. Change the `DISCORD_CHANNEL` constant to your target channel ID
3. Reinstall the hook: `npm run install-hook`

To get a Discord channel ID: Enable Developer Mode in Discord → right-click any channel → **Copy Channel ID**.

### Finding the installed copy

The installed hook lives at `~/.claude/hooks/openclaw-notify.js`. If you edit this directly, your changes will be overwritten next time `install-hook` is run. Edit the source in `~/projects/tmux-relay-cli/hooks/` instead.

---

## MAIN agent response protocol

### Part 1 — When MAIN receives a system event starting with `claude-relay-pending`

**Step 1 — Read state file**
```bash
cat /tmp/pending-relay-<session>.json
# → { session, socket, pane, notificationType, message, cwd, timestamp }
```

**Step 2 — Capture pane for full context**
```bash
tmux -S <socket> capture-pane -p -J -t <session>:0.0 -S -30
# Returns the last 30 lines of the pane — includes the question text and option list
```

**Step 3 — Format and send Discord notification**

Find or create a Discord thread named `<session>` in the configured channel.

```
🤖 **<session>** needs input

<pane capture showing question + options>

Reply with a number or free text — I'll route it back.
```

**Step 4 — Save context**

Store `{ session, socket, pane }` in working context so it's ready when Trevor replies.

---

### Part 2 — When MAIN receives a Discord reply in a relay thread

**Step 1 — Run relay-check.js with the inbound chat_id**
```bash
node /Users/clawd/projects/tmux-relay-cli/scripts/relay-check.js "<chat_id>"
# chat_id example: "channel:1476953824911425617:thread:1477207778727563457"
```

Returns:
```json
{
  "matched": true,
  "session": "claude-nomads-ops-center",
  "socket": "/tmp/.../clawdbot.sock",
  "pane": "0.0",
  "stateFile": "/tmp/pending-relay-claude-nomads-ops-center.json"
}
```

If `matched: false` → treat message as normal conversation.
If `matched: false, ambiguous: true` → multiple sessions pending, ask Trevor which one.

**Step 2 — Capture the current pane**
```bash
tmux -S <socket> capture-pane -p -J -t <session>:0.0 -S -25
# Read the question text and option list currently showing
```

**Step 3 — Resolve intent**

- Bare number (`"1"`, `"2"`) → use as-is
- Slash command (`/gsd:...`) → use as-is
- Natural language → match against pane options (see Natural Language Intent Resolution above)
- Ambiguous → send best guess, explain in reply

**Step 4 — Call tmux-relay with the RESOLVED command**
```bash
tmux-relay --session <session> --socket <socket> --reply "<resolved_command>"
```

**Step 5 — React ✅ and confirm**
```
message.react ✅
```
Reply with:
```
✅ Sent `<resolved_command>` → `<session>`
```
If natural language was interpreted, add a brief explanation:
```
✅ Sent `1` → `claude-nomads-ops-center`  (interpreted "continue" as option 1)
```

**Step 6 — Delete the state file**
```bash
rm /tmp/pending-relay-<session>.json
```

---

## Troubleshooting

### "tmux session not found: \<name\>"
The session name in `session` does not exist on the tmux server specified by `socket`. Verify with:
```bash
tmux -S /tmp/clawdbot-tmux-sockets/clawdbot.sock list-sessions
```

### "tmux not found on PATH"
`tmux` is not installed or not on the current `$PATH`. Install it (`brew install tmux` on macOS) or check your shell environment.

### "option index N out of range"
The user replied with a number larger than the number of options in the `options` array. Check that the `options` list you're providing matches what Claude Code is actually showing. If you omit `options`, no range validation occurs — the tool just sends that many Down presses.

### Pane target format
The `pane` field is `<window>.<pane>`, not `:pane`. Example: `"0.0"` (window 0, pane 0), `"1.0"` (window 1, pane 0). The session name is **not** included in this field.

### Keys appear garbled in the terminal
You may have omitted the `-l` flag or the text contains special characters. Use `dryRun: true` to inspect what would be sent, and check whether a custom tmux prefix or binding is interfering.

### Testing without a live tmux session
Use `dryRun: true` in the input JSON or `--dry-run` on the command line. No tmux process is required.

```bash
tmux-relay --session test --reply "3" --options "A,B,C" --dry-run
# → {"ok":true,"dryRun":true,"mode":"option","optionIndex":2,"optionText":"C","keysSent":["Down","Down","Enter"],...}
```
