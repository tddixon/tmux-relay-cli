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
