#!/usr/bin/env node
// openclaw-notify.js — Claude Code Notification hook
// Fires when Claude Code is waiting for input (idle_prompt / elicitation_dialog)
// Sends Discord notification DIRECTLY — bypasses system event routing issues

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const DISCORD_CHANNEL = '1476953824911425617'; // #dev-4
const OPENCLAW = '/opt/homebrew/bin/openclaw';
const SOCKET = '/tmp/clawdbot-tmux-sockets/clawdbot.sock';
const LOG = '/tmp/openclaw-notify-debug.log';

function log(msg) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch(e) {}
}

log('HOOK INVOKED (pre-parse)');

// Read notification JSON from stdin
let raw = '';
try {
  raw = fs.readFileSync('/dev/stdin', 'utf8').trim();
} catch (e) {
  log(`STDIN ERROR: ${e.message}`);
  process.exit(0);
}

if (!raw) { log('STDIN EMPTY'); process.exit(0); }

let input;
try {
  input = JSON.parse(raw);
} catch (e) {
  log(`JSON PARSE ERROR: ${e.message} — raw: ${raw.slice(0, 100)}`);
  process.exit(0);
}

const notificationType = input.notification_type || '';
const cwd = input.cwd || process.cwd();
const sessionId = input.session_id || 'unknown';
const message = input.message || 'Claude Code is waiting for input';

log(`type=${notificationType} session=${sessionId} cwd=${cwd}`);

// Only act on idle/elicitation prompts
if (!['idle_prompt', 'elicitation_dialog', 'permission_prompt'].includes(notificationType)) {
  log(`SKIP — type not actionable`);
  process.exit(0);
}

// Derive tmux session name from cwd
// Convention: claude-<project-folder-name>
const projectName = path.basename(cwd);
const sessionName = `claude-${projectName}`;

// Write pending relay state file
const stateFile = `/tmp/pending-relay-${sessionName}.json`;
const state = {
  session: sessionName,
  socket: SOCKET,
  pane: '0.0',
  notificationType,
  message,
  claudeSessionId: sessionId,
  cwd,
  timestamp: Date.now()
};
try {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  log(`State file written: ${stateFile}`);
} catch (e) {
  log(`State file write failed: ${e.message}`);
}

// Capture tmux pane for context (the actual question + options Claude is showing)
let paneContext = '';
try {
  const result = spawnSync('tmux', [
    '-S', SOCKET,
    'capture-pane', '-p', '-J',
    '-t', `${sessionName}:0.0`,
    '-S', '-20'
  ], { encoding: 'utf8', timeout: 3000 });
  if (result.stdout) {
    // Extract the meaningful last lines — question + options
    paneContext = result.stdout
      .split('\n')
      .filter(l => l.trim())
      .slice(-15)
      .join('\n');
  }
  log(`Pane captured: ${paneContext.length} chars`);
} catch (e) {
  log(`Pane capture failed: ${e.message}`);
  paneContext = message;
}

// Format Discord notification
const shortPane = paneContext.slice(-600); // keep it readable
const discordMsg = [
  `🤖 **${sessionName}** needs your input`,
  `\`\`\``,
  shortPane || message,
  `\`\`\``,
  `Reply with a number or free text — I'll route it back.`,
  `_(session: ${sessionName})_`
].join('\n');

// Send Discord notification DIRECTLY
log(`Sending Discord notification to channel ${DISCORD_CHANNEL}...`);
try {
  const result = spawnSync(OPENCLAW, [
    'message', 'send',
    '--channel', 'discord',
    '--target', DISCORD_CHANNEL,
    '--message', discordMsg
  ], { encoding: 'utf8', timeout: 8000 });

  if (result.status === 0) {
    log(`Discord send OK`);
  } else {
    log(`Discord send failed (code ${result.status}): ${result.stderr?.slice(0, 200)}`);
  }
} catch (e) {
  log(`Discord send exception: ${e.message}`);
}

process.exit(0);
