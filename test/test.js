'use strict';

const assert = require('assert');
const { parseReply, relay } = require('../src/relay');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log('\ntmux-relay-cli tests\n');

// ── parseReply() ──────────────────────────────────────────────────────────────
console.log('parseReply()');

test('parses "1" as option mode, index 0', () => {
  const r = parseReply('1');
  assert.strictEqual(r.mode, 'option');
  assert.strictEqual(r.index, 0);
});

test('parses "3" as option mode, index 2', () => {
  const r = parseReply('3');
  assert.strictEqual(r.mode, 'option');
  assert.strictEqual(r.index, 2);
});

test('parses "10" as option mode, index 9', () => {
  const r = parseReply('10');
  assert.strictEqual(r.mode, 'option');
  assert.strictEqual(r.index, 9);
});

test('parses "  2  " (whitespace) as option mode, index 1', () => {
  const r = parseReply('  2  ');
  assert.strictEqual(r.mode, 'option');
  assert.strictEqual(r.index, 1);
});

test('parses "fix the imports" as text mode', () => {
  const r = parseReply('fix the imports');
  assert.strictEqual(r.mode, 'text');
  assert.strictEqual(r.text, 'fix the imports');
});

// ── relay() dry-run ───────────────────────────────────────────────────────────
console.log('\nrelay() dry-run');

async function runAsyncTests() {
  await asyncTest('--dry-run option "2" → Down + Enter, optionText "Abort"', async () => {
    const result = await relay({
      reply: '2',
      options: ['Trust and proceed', 'Abort', 'Show diff'],
      session: 'claude-nomads',
      socket: '/tmp/clawdbot-tmux-sockets/clawdbot.sock',
      pane: '0.0',
      dryRun: true,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.mode, 'option');
    assert.strictEqual(result.optionIndex, 1);
    assert.strictEqual(result.optionText, 'Abort');
    assert.deepStrictEqual(result.keysSent, ['Down', 'Enter']);
    assert.strictEqual(result.pane, 'claude-nomads:0.0');
    assert.strictEqual(result.session, 'claude-nomads');
  });

  await asyncTest('--dry-run option "1" → only Enter (no Down keys)', async () => {
    const result = await relay({
      reply: '1',
      options: ['Trust and proceed', 'Abort'],
      session: 'test-session',
      dryRun: true,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mode, 'option');
    assert.strictEqual(result.optionIndex, 0);
    assert.deepStrictEqual(result.keysSent, ['Enter']);
  });

  await asyncTest('--dry-run text mode → C-u + text + Enter', async () => {
    const result = await relay({
      reply: 'fix the imports',
      session: 'claude-nomads',
      dryRun: true,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mode, 'text');
    assert.strictEqual(result.text, 'fix the imports');
    assert.deepStrictEqual(result.keysSent, ['C-u', 'fix the imports', 'Enter']);
  });

  await asyncTest('error: option index out of range when options array provided', async () => {
    const result = await relay({
      reply: '5',
      options: ['Option A', 'Option B', 'Option C'],
      session: 'claude-nomads',
      dryRun: true,
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('out of range'), `expected "out of range" in: "${result.error}"`);
  });

  // Summary
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runAsyncTests().catch(err => {
  console.error(err);
  process.exit(1);
});
