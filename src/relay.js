'use strict';

const { execFileSync } = require('child_process');

/**
 * Parse the user's reply string into a mode + payload.
 *
 * Returns:
 *   { mode: 'option', index: number }   — reply was a pure integer (1-based → 0-based index)
 *   { mode: 'text',   text:  string  }  — reply was free text
 */
function parseReply(replyStr) {
  const reply = String(replyStr).trim();
  if (/^\d+$/.test(reply)) {
    return { mode: 'option', index: parseInt(reply, 10) - 1 };
  }
  return { mode: 'text', text: reply };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runTmux(baseArgs, args) {
  return execFileSync('tmux', [...baseArgs, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Main relay function.
 *
 * @param {object} config
 * @param {string}   config.reply      — user's reply string (required)
 * @param {string}   config.session    — tmux session name (required)
 * @param {string[]} [config.options]  — option list for validation / labels
 * @param {string}   [config.socket]   — tmux socket path (-S); omit for default tmux
 * @param {string}   [config.pane]     — pane target "window.pane" (default "0.0")
 * @param {number}   [config.delayMs]  — ms between key sends (default 200)
 * @param {boolean}  [config.dryRun]   — print what would be sent, don't call tmux
 *
 * @returns {Promise<object>} result JSON
 */
async function relay({
  reply,
  session,
  options,
  socket,
  pane = '0.0',
  delayMs = 200,
  dryRun = false,
} = {}) {
  if (!session) return { ok: false, error: 'session is required' };
  if (reply === undefined || reply === null || reply === '')
    return { ok: false, error: 'reply is required' };

  const target = `${session}:${pane}`;
  const baseArgs = socket ? ['-S', socket] : [];
  const parsed = parseReply(reply);

  // Validate option index when options array is provided
  if (parsed.mode === 'option' && options && parsed.index >= options.length) {
    return {
      ok: false,
      error: `option index ${parsed.index + 1} out of range (${options.length} options available)`,
      session,
    };
  }

  // Build the logical key sequence for result reporting
  const keysSent = [];
  if (parsed.mode === 'option') {
    for (let i = 0; i < parsed.index; i++) keysSent.push('Down');
    keysSent.push('Enter');
  } else {
    keysSent.push('C-u');
    keysSent.push(parsed.text);
    keysSent.push('Enter');
  }

  // Dry-run: return what would be sent without calling tmux
  if (dryRun) {
    const result = { ok: true, dryRun: true, session, pane: target, keysSent };
    if (parsed.mode === 'option') {
      result.mode = 'option';
      result.optionIndex = parsed.index;
      if (options) result.optionText = options[parsed.index];
    } else {
      result.mode = 'text';
      result.text = parsed.text;
    }
    return result;
  }

  // Verify tmux is available
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  } catch {
    return { ok: false, error: 'tmux not found on PATH', session };
  }

  // Send keys to tmux
  try {
    if (parsed.mode === 'option') {
      for (let i = 0; i < parsed.index; i++) {
        runTmux(baseArgs, ['send-keys', '-t', target, 'Down']);
        if (delayMs > 0) await sleep(delayMs);
      }
      runTmux(baseArgs, ['send-keys', '-t', target, 'Enter']);
    } else {
      // Clear existing input with Ctrl-U, then send literal text, then Enter
      runTmux(baseArgs, ['send-keys', '-t', target, 'C-u']);
      await sleep(100);
      runTmux(baseArgs, ['send-keys', '-t', target, '-l', '--', parsed.text]);
      await sleep(100);
      runTmux(baseArgs, ['send-keys', '-t', target, 'Enter']);
    }
  } catch (err) {
    const msg = (err.stderr || err.message || String(err)).trim();
    if (/can't find session|session not found|no server/i.test(msg)) {
      return { ok: false, error: `tmux session not found: ${session}`, session };
    }
    return { ok: false, error: msg, session };
  }

  const result = { ok: true, session, pane: target, keysSent };
  if (parsed.mode === 'option') {
    result.mode = 'option';
    result.optionIndex = parsed.index;
    if (options) result.optionText = options[parsed.index];
  } else {
    result.mode = 'text';
    result.text = parsed.text;
  }
  return result;
}

module.exports = { parseReply, relay };
