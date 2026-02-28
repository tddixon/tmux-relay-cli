# SPEC Addendum — Hook-Based Notification (replaces polling approach)

## What Changed

After reviewing Claude Code's hooks system, we discovered a better approach.
Instead of polling tmux every 15 seconds to detect a waiting state, we use
Claude Code's built-in `Notification` hook with matcher `idle_prompt`.

This hook fires **instantly** when Claude Code needs user input — zero polling,
zero tokens, zero delay.

---

## New Component: openclaw-notify.js

Create this file at: `hooks/openclaw-notify.js`
(This will be installed to `~/.claude/hooks/openclaw-notify.js`)

### What it does

1. Reads Claude Code notification JSON from stdin
2. Derives the tmux session name from the working directory
3. Writes a pending-relay state file to `/tmp/`
4. Calls `openclaw system event --mode now` to wake the OpenClaw MAIN agent

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

### Implementation

```javascript
#!/usr/bin/env node
// openclaw-notify.js — Claude Code Notification hook
// Fires when Claude Code is waiting for input (idle_prompt / elicitation_dialog)
// Wakes OpenClaw MAIN agent via system event — zero polling, zero tokens

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Read notification JSON from stdin
let raw = '';
try {
  raw = fs.readFileSync('/dev/stdin', 'utf8').trim();
} catch (e) {
  process.exit(0); // nothing to do
}

if (!raw) process.exit(0);

let input;
try {
  input = JSON.parse(raw);
} catch (e) {
  process.exit(0);
}

const notificationType = input.notification_type || '';
const cwd = input.cwd || process.cwd();
const sessionId = input.session_id || 'unknown';
const message = input.message || 'Claude Code is waiting for input';

// Only act on idle/elicitation prompts
if (!['idle_prompt', 'elicitation_dialog', 'permission_prompt'].includes(notificationType)) {
  process.exit(0);
}

// Derive tmux session name from cwd
// Convention: project folder name → "claude-<folder-name>"
// e.g. /Users/clawd/projects/nomads-ops-center → "claude-nomads-ops-center"
const projectName = path.basename(cwd);
const sessionName = `claude-${projectName}`;
const socket = '/tmp/clawdbot-tmux-sockets/clawdbot.sock';

// Write pending relay state for MAIN to pick up
const stateFile = `/tmp/pending-relay-${sessionName}.json`;
const state = {
  session: sessionName,
  socket,
  pane: '0.0',
  notificationType,
  message,
  claudeSessionId: sessionId,
  cwd,
  timestamp: Date.now()
};

try {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
} catch (e) {
  // non-fatal — MAIN can still capture pane directly
}

// Wake MAIN immediately via openclaw system event
// MAIN will read the state file, format the notification, and send to Discord
const eventText = `claude-relay-pending session=${sessionName} type=${notificationType} cwd=${cwd}`;

try {
  execSync(`openclaw system event --mode now --text ${JSON.stringify(eventText)}`, {
    timeout: 5000,
    stdio: 'pipe'
  });
} catch (e) {
  // openclaw might not be on PATH in all environments — try full path
  try {
    execSync(`/opt/homebrew/bin/openclaw system event --mode now --text ${JSON.stringify(eventText)}`, {
      timeout: 5000,
      stdio: 'pipe'
    });
  } catch (e2) {
    // silently fail — Claude Code should not block on notification failure
  }
}

process.exit(0);
```

---

## New Component: install-hook.js

Create a simple installer script at `scripts/install-hook.js` that:

1. Copies `hooks/openclaw-notify.js` to `~/.claude/hooks/openclaw-notify.js`
2. Reads `~/.claude/settings.json`
3. Adds the `Notification` hook entry (if not already present):

```json
"Notification": [
  {
    "matcher": "idle_prompt|elicitation_dialog|permission_prompt",
    "hooks": [
      {
        "type": "command",
        "command": "node /Users/clawd/.claude/hooks/openclaw-notify.js"
      }
    ]
  }
]
```

4. Writes the updated settings.json back
5. Prints confirmation

The installer must be **non-destructive**: if a Notification hook already exists,
append to it rather than overwrite. Preserve all existing hooks.

Add to package.json scripts:
```json
"install-hook": "node scripts/install-hook.js"
```

---

## Update SKILL.md

Rewrite the notification/monitoring section of `skills/tmux-relay-cli/SKILL.md`
to document the hook-based approach:

- What the `Notification` hook does
- How `openclaw-notify.js` works  
- The state file format at `/tmp/pending-relay-<session>.json`
- How MAIN agent should handle a `claude-relay-pending` system event:
  1. Read the state file to get session, socket, pane, message
  2. Optionally capture the tmux pane for full context
  3. Send formatted Discord notification to Trevor with question + options
  4. Store session context
  5. When Trevor replies, call `tmux-relay` with the reply

### State File Schema (for SKILL.md)

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

### MAIN Agent Response Protocol (for SKILL.md)

When MAIN receives a system event matching `claude-relay-pending`:

```
1. Read /tmp/pending-relay-<session>.json
2. Run: tmux -S <socket> capture-pane -p -J -t <session>:0.0 -S -30
   (get full context: question text + option list)
3. Format Discord notification:
   🤖 **<session>** needs input
   <question from pane>
   Reply with a number or free text — I'll route it.
4. Send to Discord
5. Save {session, socket, pane, options} to working context
6. On Trevor's next reply → run tmux-relay
```

---

## Update README.md

Add a "Quick Setup" section at the top:

```bash
# 1. Install the CLI globally
npm install -g .

# 2. Install the Claude Code notification hook
npm run install-hook

# That's it. Every Claude Code session on this machine will now
# notify OpenClaw the instant it needs your input.
```

---

## File Summary

Files to CREATE (new):
- `hooks/openclaw-notify.js`       — the notification hook script
- `scripts/install-hook.js`        — hook installer

Files to UPDATE:
- `skills/tmux-relay-cli/SKILL.md` — add hook architecture docs + state file schema + MAIN protocol
- `README.md`                      — add Quick Setup section
- `package.json`                   — add `install-hook` script

---

## Completion Signal

When all done and `npm run install-hook` works correctly, run:
```bash
openclaw system event --text "Done: tmux-relay-cli hook edition complete — run npm run install-hook to wire Claude Code notifications to OpenClaw" --mode now
```
