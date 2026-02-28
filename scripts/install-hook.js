#!/usr/bin/env node
// install-hook.js — Installs openclaw-notify.js into ~/.claude/hooks
// and registers it in ~/.claude/settings.json under the Notification hook.
// Non-destructive: appends to existing Notification entries rather than overwriting.

'use strict';

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE;
if (!HOME) {
  console.error('Cannot determine home directory ($HOME is not set)');
  process.exit(1);
}

const src       = path.join(__dirname, '..', 'hooks', 'openclaw-notify.js');
const hooksDir  = path.join(HOME, '.claude', 'hooks');
const dest      = path.join(hooksDir, 'openclaw-notify.js');
const settingsPath = path.join(HOME, '.claude', 'settings.json');

// ── 1. Copy hook file ────────────────────────────────────────────────────────

if (!fs.existsSync(src)) {
  console.error(`Source hook not found: ${src}`);
  process.exit(1);
}

fs.mkdirSync(hooksDir, { recursive: true });
fs.copyFileSync(src, dest);
fs.chmodSync(dest, 0o755);
console.log(`✓ Copied hook → ${dest}`);

// ── 2. Read settings.json ────────────────────────────────────────────────────

let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    console.error(`Warning: could not parse ${settingsPath} — will create a fresh one`);
    settings = {};
  }
} else {
  console.log(`  (${settingsPath} not found — will create it)`);
}

// ── 3. Build the new hook entry ──────────────────────────────────────────────

const newEntry = {
  matcher: 'idle_prompt|elicitation_dialog|permission_prompt',
  hooks: [
    {
      type: 'command',
      command: `node ${dest}`,
    },
  ],
};

if (!settings.hooks) settings.hooks = {};

if (!settings.hooks.Notification) {
  // No Notification hooks yet — add ours
  settings.hooks.Notification = [newEntry];
  console.log('✓ Added Notification hook entry to settings.json');
} else {
  // Notification hooks exist — check if ours is already there
  const alreadyPresent = settings.hooks.Notification.some(entry =>
    Array.isArray(entry.hooks) &&
    entry.hooks.some(h => typeof h.command === 'string' && h.command.includes('openclaw-notify.js'))
  );

  if (alreadyPresent) {
    console.log('  (openclaw-notify.js hook already present in settings.json — skipping)');
  } else {
    settings.hooks.Notification.push(newEntry);
    console.log('✓ Appended Notification hook entry to existing hooks in settings.json');
  }
}

// ── 4. Write settings.json back ──────────────────────────────────────────────

try {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`✓ Saved ${settingsPath}`);
} catch (e) {
  console.error(`Failed to write ${settingsPath}: ${e.message}`);
  process.exit(1);
}

// ── 5. Confirmation ──────────────────────────────────────────────────────────

console.log('');
console.log('Hook installed successfully.');
console.log('Every Claude Code session on this machine will now notify OpenClaw');
console.log('the instant it needs your input — no polling required.');
console.log('');
console.log('Registered hook entry:');
console.log(JSON.stringify(newEntry, null, 2));
