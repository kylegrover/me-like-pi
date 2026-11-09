import assert from 'node:assert/strict';
import test from 'node:test';
import { searchArgs, searchEnv, parseSearchOutput, searchClaude, MAX_RESULT_CHARS } from '../extensions/lib/claude-search.ts';

// Shape of a real `claude -p --output-format json` result (2026-11-06, Haiku, trimmed).
const ok = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 14070,
  result: 'Node.js 26 is the latest LTS ([nodejs.org](https://nodejs.org/)).', total_cost_usd: 0.025,
  usage: { input_tokens: 6, output_tokens: 694 }, modelUsage: { 'claude-haiku-5-5': {} } });

test('args restrict Claude to web tools, no session, no settings, JSON output', () => {
  const a = searchArgs(['node lts'], 'sonnet');
  assert.equal(a[a.indexOf('--model') + 1], 'sonnet');
  assert.equal(a[a.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.equal(a[a.indexOf('--output-format') + 1], 'json');
  assert.equal(a[a.indexOf('--setting-sources') + 1], '');
  for (const flag of ['--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(a.includes(flag));
  assert.match(a[1], /1\. node lts/);
});

test('child env drops API keys so the subscription is used', () => {
  const env = searchEnv({ PATH: 'p', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CONFIG_DIR: 'c' });
  assert.deepEqual(env, { PATH: 'p', CLAUDE_CONFIG_DIR: 'c' });
});

test('parses success and rejects errors, empty and non-JSON output', () => {
  const r = parseSearchOutput(ok + '\n');
  assert.equal(r.model, 'claude-haiku-5-5');
  assert.equal(r.turns, 3);
  assert.match(r.text, /nodejs\.org/);
  assert.throws(() => parseSearchOutput(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true })), /failed/);
  assert.throws(() => parseSearchOutput(JSON.stringify({ type: 'result', subtype: 'success', result: ' ' })), /empty/);
  assert.throws(() => parseSearchOutput('Not logged in'), /no JSON/);
});

test('searchClaude: runner gets neutral cwd and clean env; failures are readable', async () => {
  let seen;
  const r = await searchClaude(['q'], undefined, async (bin, args, opts) => { seen = { bin, args, opts }; return { code: 0, stdout: ok, stderr: '' }; },
    { PATH: 'p', ANTHROPIC_API_KEY: 'k', PI_CLAUDE_SEARCH_MODEL: 'sonnet' });
  assert.equal(seen.bin, 'claude');
  assert.equal(seen.opts.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(seen.args[seen.args.indexOf('--model') + 1], 'sonnet');
  assert.match(r.text, /Node\.js 26/);
  await assert.rejects(searchClaude(['q'], undefined, async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, {}), /CLI not found/);
  await assert.rejects(searchClaude(['q'], undefined, async () => ({ code: 1, stdout: '', stderr: 'auth required' }), {}), /exited 1: auth required/);
  const long = JSON.stringify({ type: 'result', subtype: 'success', result: 'x'.repeat(MAX_RESULT_CHARS + 10) });
  assert.match((await searchClaude(['q'], undefined, async () => ({ code: 0, stdout: long, stderr: '' }), {})).text, /\[truncated\]$/);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(searchClaude(['q'], ac.signal, async (_b, _a, { signal }) => { signal.throwIfAborted(); }, {}), /cancelled/);
});
