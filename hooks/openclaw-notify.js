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
const TMPDIR = process.env.TMPDIR || '/tmp';
const SOCKET = `${TMPDIR}clawdbot-tmux-sockets/clawdbot.sock`;
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

// --- Pane Formatter ---
// Parses raw tmux output into a clean, readable Discord message
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][A-Z0-9]/g, '');
}

function formatPane(raw) {
  const noAnsi = stripAnsi(raw);
  const lines = noAnsi.split('\n')
    .map(l => l.replace(/[━─┌┐└┘├┤┬┴┼│╔╗╚╝╠╣╦╩╬═]/g, '').trim())
    .filter(l => l.length > 0);

  // Filter out pure decoration / GSD banner lines
  const meaningful = lines.filter(l =>
    !l.match(/^GSD\s*[►▶]/) &&
    !l.match(/^[░▒▓█\s]+$/) &&
    !l.match(/^⏵⏵/) &&
    !l.match(/^⬆/) &&
    !l.match(/^\d+%$/)
  );

  const parts = [];
  let foundContent = false;

  // Next Up section
  const nextUpIdx = meaningful.findIndex(l => /next\s*up/i.test(l));
  if (nextUpIdx >= 0) {
    parts.push('**▶ Next up:**');
    const nextLines = meaningful.slice(nextUpIdx + 1, nextUpIdx + 6)
      .filter(l => l && !l.match(/^[─\s]+$/) && !/also\s*available/i.test(l) && !l.match(/^\/gsd:/) && !l.startsWith('-'))
      .slice(0, 4);
    nextLines.forEach(l => parts.push(`> ${l}`));
    foundContent = true;
  }

  // GSD commands
  const gsdCmds = meaningful.filter(l => l.match(/^\/gsd:/));
  if (gsdCmds.length > 0) {
    if (parts.length) parts.push('');
    parts.push('**Commands:**');
    gsdCmds.forEach(c => parts.push(`\`${c}\``));
    foundContent = true;
  }

  // Numbered options (e.g. "1. Trust and proceed")
  const numberedOpts = meaningful.filter(l => l.match(/^\d+[.)]\s+\S/));
  if (numberedOpts.length > 0) {
    if (parts.length) parts.push('');
    parts.push('**Options:**');
    numberedOpts.forEach(o => parts.push(o));
    foundContent = true;
  }

  // Also available section
  const alsoIdx = meaningful.findIndex(l => /also\s*available/i.test(l));
  if (alsoIdx >= 0) {
    const alsoLines = meaningful.slice(alsoIdx + 1, alsoIdx + 6)
      .filter(l => l.startsWith('-') || l.startsWith('•') || l.startsWith('/'));
    if (alsoLines.length > 0) {
      if (parts.length) parts.push('');
      parts.push('**Also available:**');
      alsoLines.forEach(l => parts.push(`  ${l}`));
      foundContent = true;
    }
  }

  // Permission / elicitation prompts — find the question line
  const questionLine = meaningful.find(l =>
    l.match(/\?$/) || l.match(/allow|deny|permission|do you want/i)
  );
  if (!foundContent && questionLine) {
    parts.push(`**${questionLine}**`);
    foundContent = true;
  }

  // Fallback: last 6 meaningful lines
  if (!foundContent) {
    meaningful.slice(-6).forEach(l => parts.push(l));
  }

  return parts.join('\n').trim();
}

// Format notification body
const formattedPane = formatPane(paneContext);
const notifBody = formattedPane || message;

// Check for an existing open thread for this session
const threadFile = `/tmp/discord-thread-${sessionName}.json`;
let existingThread = null;
try {
  const tf = JSON.parse(fs.readFileSync(threadFile, 'utf8'));
  // Only reuse thread if it's less than 2 hours old
  if (Date.now() - tf.createdAt < 2 * 60 * 60 * 1000) {
    existingThread = tf;
  }
} catch(e) {}

if (existingThread) {
  // Post follow-up into the existing thread
  log(`Reusing thread ${existingThread.threadId} for ${sessionName}`);
  const followupMsg = [
    `🤖 **${sessionName}** needs input again`,
    ``,
    notifBody,
    ``,
    `Reply here to route back.`
  ].join('\n');

  try {
    const result = spawnSync(OPENCLAW, [
      'message', 'thread', 'reply',
      '--channel', 'discord',
      '--target', existingThread.threadId,
      '--message', followupMsg
    ], { encoding: 'utf8', timeout: 8000 });
    log(`Thread reply status: ${result.status} stderr: ${result.stderr?.slice(0,100)}`);
  } catch(e) {
    log(`Thread reply failed: ${e.message}`);
  }

} else {
  // Create a new thread for this session
  const initialMsg = [
    `🤖 **${sessionName}** is waiting for input`,
    ``,
    notifBody,
    ``,
    `Reply with a number or free text — I'll route it back.`,
    `-# session: \`${sessionName}\``
  ].join('\n');

  log(`Creating Discord thread for ${sessionName}...`);
  try {
    const result = spawnSync(OPENCLAW, [
      'message', 'thread', 'create',
      '--channel', 'discord',
      '--target', DISCORD_CHANNEL,
      '--thread-name', sessionName,
      '--message', initialMsg,
      '--json'
    ], { encoding: 'utf8', timeout: 8000 });

    if (result.status === 0) {
      log(`Thread created OK`);
      // Parse thread ID from JSON output and save for reuse
      try {
        const out = JSON.parse(result.stdout);
        const threadId = out?.payload?.thread?.id;
        if (threadId) {
          fs.writeFileSync(threadFile, JSON.stringify({
            threadId,
            sessionName,
            createdAt: Date.now()
          }));
          log(`Thread ID saved: ${threadId}`);
        } else {
          log(`Thread ID not found in output: ${result.stdout?.slice(0,200)}`);
        }
      } catch(e) { log(`Could not parse thread ID: ${e.message} stdout: ${result.stdout?.slice(0,100)}`); }
    } else {
      // Thread creation failed — fall back to direct channel message
      log(`Thread create failed (${result.status}), falling back to channel message`);
      log(`stderr: ${result.stderr?.slice(0, 200)}`);
      const fallbackMsg = [
        `🤖 **${sessionName}** needs input`,
        `\`\`\``,
        notifBody,
        `\`\`\``,
        `Reply with: \`relay ${sessionName}: <your reply>\``
      ].join('\n');
      spawnSync(OPENCLAW, [
        'message', 'send',
        '--channel', 'discord',
        '--target', DISCORD_CHANNEL,
        '--message', fallbackMsg
      ], { encoding: 'utf8', timeout: 8000 });
      log(`Fallback channel message sent`);
    }
  } catch (e) {
    log(`Thread create exception: ${e.message}`);
  }
}

process.exit(0);
