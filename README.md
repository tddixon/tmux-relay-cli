# tmux-relay-cli

Routes Lobster workflow approval replies back to a waiting Claude Code tmux session. When Claude Code pauses and presents the user with numbered options (e.g. "1. Trust and proceed  2. Abort"), Lobster sends a notification to Discord or Telegram. The user replies with either a number or free text. `tmux-relay` receives that reply, figures out whether to navigate a menu (Down × N + Enter) or send literal text (Ctrl-U + literal + Enter), and fires the appropriate key sequences at the right tmux pane — all without any manual intervention.

---

## Quick Setup

```bash
# 1. Install the CLI globally
npm install -g .

# 2. Install the Claude Code notification hook
npm run install-hook

# That's it. Every Claude Code session on this machine will now
# notify OpenClaw the instant it needs your input.
```

---

## Installation

```bash
# From this repo (local install)
cd ~/projects/tmux-relay-cli
npm install -g .

# Verify
tmux-relay --help || echo "installed"
```

---

## Quick test (dry-run — no tmux needed)

```bash
# Flag mode
tmux-relay --session claude-nomads --reply "2" --options "Trust and proceed,Abort,Show diff" --dry-run

# Stdin JSON mode
echo '{"reply":"fix the imports","session":"claude-nomads","dryRun":true}' | tmux-relay
```

---

## Usage

### Stdin / Lobster pipeline mode (primary)

```bash
echo '{
  "reply": "2",
  "options": ["Trust and proceed", "Abort", "Show diff"],
  "session": "claude-nomads",
  "socket": "/tmp/clawdbot-tmux-sockets/clawdbot.sock"
}' | tmux-relay
```

### Flag mode (manual / test)

```bash
tmux-relay \
  --session claude-nomads \
  --socket /tmp/clawdbot-tmux-sockets/clawdbot.sock \
  --reply "2" \
  --options "Trust and proceed,Abort,Show diff"

# With explicit pane target
tmux-relay --session claude-nomads --pane 0.0 --reply "fix the imports"
```

---

## Lobster step example

```yaml
- name: route_input
  run: |
    echo '{{ approval_payload | tojson }}' | tmux-relay
```

Where `approval_payload` is an object with `reply`, `options`, `session`, `socket`.

---

## Input JSON reference

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `reply` | Yes | — | User's reply string |
| `session` | Yes | — | tmux session name |
| `options` | No | — | Array of option strings (for validation + labels) |
| `socket` | No | `/tmp/clawdbot-tmux-sockets/clawdbot.sock` | tmux socket path |
| `pane` | No | `0.0` | Pane target as `window.pane` |
| `delayMs` | No | `200` | ms to wait between key sends |
| `dryRun` | No | `false` | Return what would be sent without calling tmux |

---

## Output JSON reference

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

---

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (see `error` field in JSON output and stderr) |

---

## Run tests

```bash
npm test
```
