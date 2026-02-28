#!/usr/bin/env node
// relay-check.js
// Given a chat_id or raw ID, check if it matches a pending tmux relay.
// Returns JSON: { matched: true/false, session, socket, pane, stateFile }
// Usage: node relay-check.js <chat_id_or_id>
//        node relay-check.js "channel:1476953824911425617:thread:1477207778727563457"
//        node relay-check.js "1477207778727563457"
//        node relay-check.js --list   (list all pending relays)

'use strict';

const fs = require('fs');
const path = require('path');

const TMPDIR = process.env.TMPDIR || '/tmp';

// Extract numeric IDs from a string (chat_id may contain multiple)
function extractIds(str) {
  const matches = String(str).match(/\d{17,19}/g) || [];
  return [...new Set(matches)];
}

// Load all discord-thread mapping files
function loadThreadMaps() {
  const maps = [];
  try {
    const files = fs.readdirSync('/tmp').filter(f => f.startsWith('discord-thread-'));
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join('/tmp', f), 'utf8'));
        // Only include if not expired (2 hours)
        if (Date.now() - data.createdAt < 2 * 60 * 60 * 1000) {
          maps.push(data);
        }
      } catch(e) {}
    }
  } catch(e) {}
  return maps;
}

// Load all pending relay state files
function loadPendingRelays() {
  const relays = [];
  try {
    const files = fs.readdirSync('/tmp').filter(f => f.startsWith('pending-relay-'));
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join('/tmp', f), 'utf8'));
        relays.push({ ...data, stateFile: path.join('/tmp', f) });
      } catch(e) {}
    }
  } catch(e) {}
  // Sort newest first
  return relays.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

const args = process.argv.slice(2);

if (args[0] === '--list') {
  const relays = loadPendingRelays();
  const maps = loadThreadMaps();
  console.log(JSON.stringify({
    pendingRelays: relays.map(r => ({
      session: r.session,
      notificationType: r.notificationType,
      age: Math.round((Date.now() - r.timestamp) / 1000) + 's ago',
      stateFile: r.stateFile
    })),
    threadMaps: maps
  }, null, 2));
  process.exit(0);
}

const inputId = args[0] || '';
const candidateIds = extractIds(inputId);

if (candidateIds.length === 0) {
  console.log(JSON.stringify({ matched: false, reason: 'No numeric IDs found in input' }));
  process.exit(0);
}

// Try to match against thread maps
const maps = loadThreadMaps();
const relays = loadPendingRelays();

let matchedSession = null;
for (const id of candidateIds) {
  const map = maps.find(m => m.threadId === id);
  if (map) {
    // Found a thread match — find the pending relay for this session
    const relay = relays.find(r => r.session === map.sessionName);
    if (relay) {
      matchedSession = relay;
      break;
    }
  }
}

// If no thread match, fall back to most recent pending relay (single-session case)
if (!matchedSession && relays.length === 1) {
  matchedSession = relays[0];
  matchedSession._fallback = true;
}

if (matchedSession) {
  console.log(JSON.stringify({
    matched: true,
    session: matchedSession.session,
    socket: matchedSession.socket,
    pane: matchedSession.pane || '0.0',
    stateFile: matchedSession.stateFile,
    fallback: matchedSession._fallback || false
  }));
  process.exit(0);
}

// Multiple pending, no thread match
if (relays.length > 1) {
  console.log(JSON.stringify({
    matched: false,
    ambiguous: true,
    pendingSessions: relays.map(r => r.session),
    reason: 'Multiple pending relays — thread match required'
  }));
  process.exit(0);
}

console.log(JSON.stringify({ matched: false, reason: 'No pending relay found' }));
process.exit(0);
