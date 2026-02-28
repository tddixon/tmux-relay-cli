#!/usr/bin/env node
// openclaw-notify.js — Claude Code Notification hook
// Fires when Claude Code is waiting for input (idle_prompt / elicitation_dialog)
// Sends Discord notification DIRECTLY — bypasses system event routing issues

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const DISCORD_CHANNEL_DEFAULT = '1476953824911425617'; // #dev-4 fallback
const DISCORD_MENTION = '<@1080149602520547368>'; // Trevor
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

// Read per-session Discord channel config (written by MAIN when starting session)
let DISCORD_CHANNEL = DISCORD_CHANNEL_DEFAULT;
try {
  const configFile = `/tmp/relay-config-${sessionName}.json`;
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (config.discordChannel) {
    DISCORD_CHANNEL = config.discordChannel;
    log(`Using channel from config: ${DISCORD_CHANNEL}`);
  }
} catch(e) { /* no config file — use default */ }

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
      .slice(-40)
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

  // Filter out noise lines
  const meaningful = lines.filter(l =>
    !l.match(/^GSD\s*[►▶]/) &&
    !l.match(/^[░▒▓█\s]+$/) &&
    !l.match(/^⏵⏵/) &&
    !l.match(/^⬆/) &&
    !l.match(/^✻\s+Churned/) &&
    !l.match(/^❯\s*$/) &&
    !l.match(/^\d+%$/)
  );

  const parts = [];
  let foundContent = false;

  // ── Checkpoint / Human Verify ──────────────────────────────────────────────
  const checkpointIdx = meaningful.findIndex(l => /checkpoint|human.{0,12}verif/i.test(l));
  if (checkpointIdx >= 0) {
    // Plan title
    const planLine = meaningful.slice(checkpointIdx, checkpointIdx + 4).find(l => /^Plan:/i.test(l));
    if (planLine) {
      parts.push(`**🔍 ${planLine}**`);
    } else {
      // Use the checkpoint line itself, strip leading symbols
      const title = meaningful[checkpointIdx].replace(/^[⏺✓•✗\s]+/, '').trim();
      parts.push(`**🔍 ${title}**`);
    }

    // Summary line (e.g. "All 6 automated checks passed...")
    const summaryLine = meaningful.slice(checkpointIdx, checkpointIdx + 8)
      .find(l => /checks? passed|automated|items? need/i.test(l));
    if (summaryLine) {
      parts.push(`> ${summaryLine}`);
    }

    // What's ready summary
    const readyIdx = meaningful.findIndex(l => /what.?s ready/i.test(l));
    if (readyIdx >= 0) {
      // Include inline content from "What's ready: <text>" line itself
      const inlineSummary = meaningful[readyIdx].replace(/what.?s ready:\s*/i, '').trim();
      const continuationLines = meaningful.slice(readyIdx + 1, readyIdx + 4)
        .filter(l => !l.match(/^---/) && !/to verify|run this/i.test(l) && l.length > 0).slice(0, 2);
      const readyLines = [inlineSummary, ...continuationLines].filter(Boolean).slice(0, 2);
      if (readyLines.length) {
        parts.push('');
        parts.push('**✅ What\'s ready:**');
        readyLines.forEach(l => parts.push(`> ${l}`));
      }
    }

    // Verification commands
    const verifyIdx = meaningful.findIndex(l => /to verify|run this/i.test(l));
    if (verifyIdx >= 0) {
      const cmds = meaningful.slice(verifyIdx + 1, verifyIdx + 6)
        .filter(l => l.match(/^(cd |npm |yarn |bun |npx |http)/i)).slice(0, 3);
      if (cmds.length) {
        parts.push('');
        parts.push('**🖥 Verify:**');
        cmds.forEach(c => parts.push(`\`${c}\``));
      }
    }

    // Confirmation items (bullet points under the checkpoint)
    const confirmItems = meaningful.slice(checkpointIdx, checkpointIdx + 15)
      .filter(l => l.startsWith('-') && l.length > 2).slice(0, 3);
    if (confirmItems.length) {
      parts.push('');
      parts.push('**Confirm:**');
      confirmItems.forEach(l => parts.push(`  ${l}`));
    }

    // Expected reply — extract the key word from "Type X" instruction
    const replyIdx = meaningful.findIndex(l => /type\s+["'`]?\w/i.test(l));
    if (replyIdx >= 0) {
      const typeMatch = meaningful[replyIdx].match(/type\s+["'`]?(\w+)/i);
      const keyword = typeMatch ? `\`${typeMatch[1]}\`` : '"approved"';
      parts.push('');
      parts.push(`**👉 Reply:** ${keyword} to confirm, or describe any issues`);
    } else {
      parts.push('');
      parts.push('**👉 Reply:** `approved` or describe any issues');
    }

    foundContent = true;
  }

  // ── GSD "Next Up" menu ────────────────────────────────────────────────────
  if (!foundContent) {
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

    // Also available
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
  }

  // ── Numbered options (permission prompts only — not GSD plan summaries) ──
  // GSD plan summaries look like "1. 01-01: Plan name" — skip those
  const numberedOpts = meaningful.filter(l =>
    l.match(/^\d+[.)]\s+\S/) && !l.match(/^\d+[.)]\s+\d{2}-\d{2}:/)
  );
  if (numberedOpts.length > 0) {
    if (parts.length) parts.push('');
    parts.push('**Options:**');
    numberedOpts.forEach(o => parts.push(o));
    foundContent = true;
  }

  // ── Fallback: raw pane in code block ─────────────────────────────────────
  if (!foundContent) {
    const rawFallback = meaningful.slice(-20).join('\n');
    parts.push('```');
    parts.push(rawFallback);
    parts.push('```');
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
    `${DISCORD_MENTION} 🤖 **${sessionName}** needs input again`,
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
    `${DISCORD_MENTION} 🤖 **${sessionName}** is waiting for input`,
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
