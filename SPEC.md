# tmux-relay-cli — Build Spec

## What This Is

A small Node.js CLI that acts as the "last mile" between a Lobster workflow approval gate
and a running Claude Code tmux session.

When Claude Code is waiting for input (it shows a question + numbered options),
Lobster pauses and sends a notification to the user (via Discord/Telegram).
The user replies with either:
- A number (e.g. "2") → navigate to that option using arrow keys + Enter
- Free text (e.g. "skip this step") → Ctrl+U to clear + send-keys -l + Enter

This CLI handles that routing logic.

---

## Project Structure

```
tmux-relay-cli/
├── package.json
├── README.md
├── bin/
│   └── tmux-relay.js       # CLI entry point (executable)
├── src/
│   └── relay.js            # Core relay logic
└── skills/
    └── tmux-relay-cli/
        └── SKILL.md        # Agent skill documentation
```

---

## CLI Interface

### Binary name: `tmux-relay`

### Usage

```bash
# Via stdin (Lobster pipeline mode — primary use)
echo '{"reply":"2","options":["Trust and proceed","Abort","Show diff"],"session":"claude-nomads","socket":"/tmp/clawdbot-tmux-sockets/clawdbot.sock"}' | tmux-relay

# Via flags (manual/test mode)
tmux-relay --session claude-nomads --socket /tmp/clawdbot-tmux-sockets/clawdbot.sock --reply "2" --options "Trust and proceed,Abort,Show diff"

# With pane target (optional, defaults to :0.0)
tmux-relay --session claude-nomads --pane 0.0 --reply "fix the imports"
```

### Arguments / Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--session` | Yes (or stdin) | — | tmux session name |
| `--socket` | No | `/tmp/clawdbot-tmux-sockets/clawdbot.sock` | tmux socket path |
| `--pane` | No | `0.0` | tmux pane target (window.pane) |
| `--reply` | Yes (or stdin) | — | The user's reply string |
| `--options` | No | — | Comma-separated option list (for numbered routing) |
| `--delay` | No | `200` | ms to wait between key sends |
| `--dry-run` | No | false | Print what would be sent without sending |
| `--json` | No | false | Force JSON output (always true when stdin is JSON) |

---

## Input JSON Schema (stdin / Lobster mode)

```json
{
  "reply": "2",
  "options": ["Trust and proceed", "Abort", "Show diff", "Open editor"],
  "session": "claude-nomads",
  "socket": "/tmp/clawdbot-tmux-sockets/clawdbot.sock",
  "pane": "0.0",
  "delayMs": 200
}
```

All fields except `reply` and `session` are optional.
If stdin is not JSON, treat it as the raw reply string (fallback).

---

## Output JSON Schema

### Success
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

### Success (free text)
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

---

## Core Routing Logic

### Step 1: Parse the reply

```
reply = trim(userReply)

if reply matches /^\d+$/:
  mode = "option"
  index = parseInt(reply) - 1   # user says "1" = first option = index 0
else:
  mode = "text"
```

### Step 2: Validate

For "option" mode:
- If options array is provided and index is out of range → error
- If options array not provided → use index to calculate arrow key count

### Step 3: Send to tmux

**Option mode (navigating Claude Code's menu):**

Claude Code typically starts with option 1 already highlighted.
To get to option N:
- Send `Down` arrow key (N-1) times
- Send `Enter`

```bash
# Example: user replied "3", need to press Down twice then Enter
tmux -S $SOCKET send-keys -t $SESSION:$PANE Down     # move to option 2
tmux -S $SOCKET send-keys -t $SESSION:$PANE Down     # move to option 3
tmux -S $SOCKET send-keys -t $SESSION:$PANE Enter    # confirm
```

Add `--delay` ms between each key send (default 200ms).

**Text mode:**

```bash
tmux -S $SOCKET send-keys -t $SESSION:$PANE C-u           # clear any existing input
sleep 0.1
tmux -S $SOCKET send-keys -t $SESSION:$PANE -l -- "$text" # send literal text (MUST use -l flag)
sleep 0.1
tmux -S $SOCKET send-keys -t $SESSION:$PANE Enter         # submit
```

**CRITICAL:** Always use `-l` flag for literal text sends. Without it, special characters get interpreted as tmux key bindings and corrupt the input.

### Step 4: Verify send succeeded

After sending, capture the pane and verify tmux didn't return an error.
If the session/pane doesn't exist → return error JSON.

---

## Implementation Notes

- **Zero dependencies preferred.** Use only Node.js built-ins (child_process, readline).
- If a dependency is truly needed (e.g. for arg parsing), use `minimist` only.
- Must work with Node.js 18+.
- Executable: set `#!/usr/bin/env node` and `chmod +x`.
- The `tmux` binary must be on PATH — check for it at startup and error clearly if missing.
- All errors go to stderr as plain text AND are returned in output JSON (stdout).
- Exit codes: 0 = success, 1 = error.

---

## package.json

```json
{
  "name": "tmux-relay-cli",
  "version": "1.0.0",
  "description": "Routes Lobster workflow approvals back to tmux sessions (Claude Code relay)",
  "bin": {
    "tmux-relay": "./bin/tmux-relay.js"
  },
  "scripts": {
    "test": "node test/test.js"
  },
  "keywords": ["tmux", "lobster", "openclaw", "claude-code", "relay"],
  "license": "MIT"
}
```

---

## README.md

Include:
- What it does (1 paragraph)
- Installation: `npm install -g .` (local) and eventually `npm install -g tmux-relay-cli`
- Quick test command (dry-run)
- Lobster pipeline example (copy from SKILL.md)
- Input/output JSON reference

---

## SKILL.md (create at: skills/tmux-relay-cli/SKILL.md)

This is critical — it's how AI agents will know how to use the tool.

The SKILL.md must include:

1. **What it does** — one paragraph, no jargon
2. **When to use it** — "Use when routing a user's reply from a Lobster approval gate back to a waiting Claude Code tmux session"
3. **Installation** — `npm install -g .` from the project dir
4. **Lobster pipeline usage** — full `.lobster` step example showing it as the `route_input` step
5. **Input JSON reference** — full schema with all fields
6. **Output JSON reference** — success + error examples
7. **Reply routing rules** — explain number vs text routing clearly for agents
8. **Critical rules** — the `-l` flag, the Down-key navigation pattern, the delay between keys
9. **Troubleshooting** — session not found, tmux not on PATH, pane target format

---

## Tests (basic)

Create `test/test.js` with:
1. `--dry-run` mode: verify it outputs correct JSON without actually calling tmux
2. Parse "1" as option mode, index 0
3. Parse "3" as option mode, index 2
4. Parse "fix the imports" as text mode
5. Parse "  2  " (whitespace) as option mode
6. Parse "10" as option mode (10th option)
7. Error case: index out of range when options array provided

---

## Completion Signal

When fully built and tests pass, run:
```bash
openclaw system event --text "Done: tmux-relay-cli built — binary ready at ~/projects/tmux-relay-cli, install with npm install -g . from that dir" --mode now
```
