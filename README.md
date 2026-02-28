# tmux-relay-cli

> Instant Claude Code notifications + natural language reply routing via Discord threads

Zero polling. Zero tokens for detection. Fires the instant Claude Code needs your input.

---

## How It Works

```
Claude Code pauses waiting for input
          │
          ▼  (fires instantly via hook — no polling)
~/.claude/hooks/openclaw-notify.js
          │  derives tmux session from cwd
          │  writes /tmp/pending-relay-<session>.json
          │  sends Discord message directly to thread
          │
          ▼
Discord thread named "<session>" gets created (or reused)
          │  posts pane context + question
          │  "Reply with a number or free text — I'll route it back."
          │
          ▼
You reply in Discord (natural language OK)
          │
          ▼
OpenClaw MAIN agent receives reply
          │  runs relay-check.js → matches thread → session name
          │  captures current tmux pane (reads question + options)
          │  resolves your intent to exact command
          │
          ▼
tmux-relay sends keystrokes to Claude Code
          │  numbers → arrow keys + Enter
          │  free text → C-u + literal + Enter
          │
          ▼
Claude Code continues ✅
```

**Key architectural decisions:**
- **Zero polling** — hook-based, not cron
- **Zero tokens for detection** — shell hook fires, not LLM
- **Direct Discord messaging** — not system event routing
- **Per-session threads** — not channel flooding
- **Thread name = tmux session name** — easy to match
- **Natural language intent resolution** — MAIN interprets before sending
- **TMPDIR-aware socket paths** — macOS compatible
- **Thread reuse within 2 hours** — follow-up questions stay in same thread

---

## Quick Setup (2 steps)

```bash
npm install -g .
npm run install-hook
```

That's it. Every Claude Code session on this machine now notifies you the instant it needs input.

**What `install-hook` does:**
1. Copies `hooks/openclaw-notify.js` to `~/.claude/hooks/`
2. Registers it in `~/.claude/settings.json` under `hooks.Notification`
3. Non-destructive — appends to existing hooks, never overwrites

---

## What You See in Discord

When Claude Code pauses, a thread is automatically created (or reused) in your configured channel:

```
#dev-4
  └── 🧵 claude-nomads-ops-center     ← thread named after tmux session
        Claude Code is waiting for input

        ╭─ claude-nomads-ops-center ──────────────────────────────╮
        │ Would you like to read the files?                       │
        │  1. Yes, continue                                        │
        │  2. No, skip context                                     │
        │  3. Let me decide later                                  │
        ╰─────────────────────────────────────────────────────────╯

        Reply with a number or free text — I'll route it back.
```

---

## Natural Language Replies

You don't need to type exact commands or numbers. Just describe your intent:

| You say | Claude Code gets |
|---------|-----------------|
| `"1"` / `"2"` / `"3"` | That exact option |
| `"continue"` / `"yes"` / `"go ahead"` | Option 1 / Enter |
| `"skip context"` | Whichever option says "skip" or "no context" |
| `"let's plan it"` | `/gsd:plan-phase 1` (slash command, if recognized) |
| `"abort"` / `"stop"` / `"no"` | Cancel / no / abort option |
| `"just do it"` | Option 1 (proceed) |
| Any free text | Typed literally into the pane |

The OpenClaw MAIN agent captures the current pane content, reads the question and options, interprets your intent against what's actually showing, and sends the right command.

---

## How Reply Routing Works

1. You reply in the Discord thread
2. OpenClaw MAIN receives the reply via Discord
3. MAIN runs `relay-check.js` with the thread/channel ID from message metadata
4. `relay-check.js` matches the thread ID → session name via `/tmp/discord-thread-<session>.json`
5. MAIN captures the current tmux pane: `tmux capture-pane -p -J -t <session>:0.0 -S -25`
6. MAIN resolves your natural language to the right command
7. MAIN calls `tmux-relay --session <name> --reply "<resolved>"`
8. Keystrokes sent to Claude Code:
   - Number → (N-1) Down presses + Enter
   - Free text → C-u + literal text + Enter
9. MAIN reacts ✅ and replies with what was sent

---

## Configuration

### Discord Channel

Notifications go to the channel ID set in `hooks/openclaw-notify.js`:

```js
const DISCORD_CHANNEL = '1476953824911425617'; // Change this to your channel ID
```

To change it:

1. Edit `hooks/openclaw-notify.js` (the source copy in this repo)
2. Change `DISCORD_CHANNEL` to your Discord channel ID
3. Run `npm run install-hook` to reinstall the hook

To get your Discord channel ID: Enable Developer Mode in Discord → right-click any channel → **Copy Channel ID**.

### Session Naming

The Discord thread name matches your tmux session name. The hook derives it automatically from the project `cwd`:

| Project path | tmux session | Discord thread |
|-------------|-------------|---------------|
| `/Users/you/projects/my-app` | `claude-my-app` | `claude-my-app` |
| `/Users/clawd/projects/nomads-ops-center` | `claude-nomads-ops-center` | `claude-nomads-ops-center` |

**Convention:** Always name Claude Code tmux sessions `claude-<project-folder-name>`.

### Multiple Sessions

Each Claude Code session gets its own Discord thread automatically. Run 3 sessions in parallel — get 3 separate threads, zero confusion.

---

## CLI Reference

### Via stdin (pipe mode)

```bash
echo '{"reply":"2","session":"claude-my-app","socket":"/tmp/..."}' | tmux-relay
```

### Via flags

```bash
tmux-relay --session claude-my-app --reply "1" --socket /tmp/clawdbot-tmux-sockets/clawdbot.sock
```

### Dry run (no live session needed)

```bash
tmux-relay --session claude-my-app --reply "fix the imports" --dry-run
```

### Reply Routing Rules

| Reply | Mode | Keys sent |
|-------|------|-----------|
| `"1"` | option | `Enter` |
| `"2"` | option | `Down`, `Enter` |
| `"3"` | option | `Down`, `Down`, `Enter` |
| Any non-number text | text | `C-u`, literal text, `Enter` |

---

## relay-check.js

Used by MAIN to detect whether an inbound message is a pending Claude Code relay:

```bash
# Check a specific thread or channel ID
node scripts/relay-check.js "channel:1476953824911425617:thread:1477207778727563457"

# List all pending relays
node scripts/relay-check.js --list
```

Returns JSON:

```json
{
  "matched": true,
  "session": "claude-nomads-ops-center",
  "socket": "/tmp/.../clawdbot.sock",
  "pane": "0.0",
  "stateFile": "/tmp/pending-relay-claude-nomads-ops-center.json"
}
```

---

## State Files

The hook writes two files per session:

### `/tmp/pending-relay-<session>.json`
Relay state — written when Claude Code needs input, deleted after reply is routed.

```json
{
  "session": "claude-nomads-ops-center",
  "socket": "/tmp/.../clawdbot.sock",
  "pane": "0.0",
  "notificationType": "idle_prompt",
  "message": "Claude is waiting for input",
  "cwd": "/Users/clawd/projects/nomads-ops-center",
  "timestamp": 1709123456789
}
```

### `/tmp/discord-thread-<session>.json`
Thread ID mapping — reused for 2 hours so follow-up questions land in the same thread.

```json
{
  "threadId": "1477207778727563457",
  "session": "claude-nomads-ops-center",
  "createdAt": 1709123456789
}
```

---

## Project Structure

```
tmux-relay-cli/
├── bin/
│   └── tmux-relay.js          # CLI entry point (stdin/flags)
├── src/
│   └── relay.js               # Core routing logic
├── hooks/
│   └── openclaw-notify.js     # Claude Code Notification hook
├── scripts/
│   ├── install-hook.js        # Registers hook in ~/.claude/settings.json
│   └── relay-check.js         # Thread ID → session lookup
├── skills/
│   └── tmux-relay-cli/
│       └── SKILL.md           # Agent skill docs
├── test/
│   └── test.js                # 9 tests
├── package.json
└── README.md
```

---

## Requirements

- Node.js 18+
- tmux on PATH (`brew install tmux`)
- OpenClaw Gateway running locally
- Claude Code with `~/.claude/settings.json` hooks support
- Discord bot configured in OpenClaw

---

## Troubleshooting

### Notifications not arriving in Discord

1. Check the debug log: `tail -f /tmp/openclaw-notify-debug.log`
2. Verify the hook is registered: `cat ~/.claude/settings.json | grep openclaw-notify`
3. Verify OpenClaw Gateway is running: `openclaw gateway status`

### "tmux session not found: \<name\>"

The session name doesn't exist on the expected socket. Verify:

```bash
tmux -S /tmp/clawdbot-tmux-sockets/clawdbot.sock list-sessions
```

### Relay not matching (relay-check returns `matched: false`)

1. Verify the state file exists: `ls /tmp/pending-relay-*.json`
2. Verify the thread file exists: `ls /tmp/discord-thread-*.json`
3. Check that the thread ID in the inbound message matches what's in the thread file

### Testing without Claude Code running

```bash
# Dry run — no tmux session required
tmux-relay --session my-session --reply "1" --dry-run

# Simulate a hook fire
echo '{"notification_type":"idle_prompt","message":"test","cwd":"/Users/you/projects/my-app"}' \
  | node ~/.claude/hooks/openclaw-notify.js
```

---

## License

MIT
