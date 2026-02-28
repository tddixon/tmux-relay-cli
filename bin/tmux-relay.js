#!/usr/bin/env node
'use strict';

const { relay } = require('../src/relay');

const DEFAULT_SOCKET = '/tmp/clawdbot-tmux-sockets/clawdbot.sock';

// Minimal arg parser — zero dependencies
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function die(msg, useJson, session) {
  process.stderr.write(msg + '\n');
  if (useJson) {
    const out = { ok: false, error: msg };
    if (session) out.session = session;
    process.stdout.write(JSON.stringify(out) + '\n');
  }
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let config = {};
  let useJson = !!(args.json);

  // Read stdin if it's piped
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8').trim();

    if (raw.startsWith('{')) {
      try {
        config = JSON.parse(raw);
        useJson = true;
      } catch {
        // Not valid JSON — treat as raw reply
        config.reply = raw;
      }
    } else if (raw.length > 0) {
      config.reply = raw;
    }
  }

  // CLI flags override / supplement stdin values
  if (args.session) config.session = args.session;
  if (args.socket)  config.socket  = args.socket;
  if (args.pane)    config.pane    = args.pane;
  if (args.reply)   config.reply   = args.reply;
  if (args.delay)   config.delayMs = parseInt(args.delay, 10);
  if (args['dry-run']) config.dryRun = true;
  if (args.options) config.options = args.options.split(',').map(s => s.trim());

  // Apply defaults
  if (!config.pane)    config.pane    = '0.0';
  if (!config.delayMs) config.delayMs = 200;
  if (!config.socket)  config.socket  = DEFAULT_SOCKET;

  // Validate required fields
  if (!config.session) die('--session is required', useJson, undefined);
  if (config.reply === undefined || config.reply === null || config.reply === '') {
    die('--reply is required', useJson, config.session);
  }

  let result;
  try {
    result = await relay(config);
  } catch (err) {
    result = { ok: false, error: err.message, session: config.session };
  }

  process.stdout.write(JSON.stringify(result) + '\n');

  if (!result.ok) {
    process.stderr.write((result.error || 'unknown error') + '\n');
    process.exit(1);
  }
}

main().catch(err => {
  process.stderr.write(err.message + '\n');
  process.exit(1);
});
