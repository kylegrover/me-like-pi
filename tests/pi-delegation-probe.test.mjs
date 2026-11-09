import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { PROBE_LIMITS, AFFINITY_PROBE_LIMITS, probeCases, affinityProbeCases, applyProbeAffinity,
  observedUsage, runCacheProbe, summarizeProbe } from '../scripts/lib/delegation-cache-probe.mjs';
import { loadDelegationNative } from './helpers/delegation-native.mjs';

const rawUsage = { input_tokens: 24000, output_tokens: 3, total_tokens: 24003,
  input_tokens_details: { cached_tokens: 23040 } };
const send = async (scenario, hooks) => {
  hooks.onPayload(applyProbeAffinity({ model: 'synthetic', input: scenario.messages,
    prompt_cache_key: scenario.sessionId }, scenario));
  return { httpAttempts: 1, httpStatus: 200, rawUsage, cost: 0.01, stopReason: 'stop', acknowledged: true };
};

test('probe plans exactly six independent scenarios/cohort with a bounded synthetic body', () => {
  const a = probeCases(1), b = probeCases(2);
  assert.equal(a.length, 6);
  assert.equal(a[0].sessionId, a[1].sessionId);
  assert.notEqual(a[0].sessionId, a[2].sessionId);
  assert.notEqual(a[2].sessionId, a[3].sessionId);
  assert.equal(a[4].sessionId, a[0].sessionId);
  assert.notEqual(a[0].sessionId, b[0].sessionId);
  assert.deepEqual(a[2].messages, a[0].messages);
  assert.deepEqual(a[3].messages.slice(0, 2), a[0].messages);
  assert.equal(a[3].messages[2].toolsRemoved.length, 3);
  assert.notEqual(a[5].messages[0].content, a[0].messages[0].content);
  for (const c of a) assert.ok(Buffer.byteLength(JSON.stringify(c.messages)) < PROBE_LIMITS.maxBodyBytes);
});

test('affinity follow-up isolates only body key with identical worker context and headers', () => {
  const [seed, warm, own, shared] = affinityProbeCases(1);
  assert.equal(seed.sessionId, warm.sessionId);
  assert.notEqual(seed.sessionId, own.sessionId);
  assert.equal(own.sessionId, shared.sessionId);
  assert.equal(shared.cacheKeyOverride, seed.sessionId);
  assert.equal(own.cacheKeyOverride, undefined);
  assert.deepEqual(own.messages, shared.messages);
  assert.deepEqual(own.messages.slice(0, seed.messages.length), seed.messages);
  assert.notEqual(affinityProbeCases(2)[0].sessionId, seed.sessionId);
});

test('probe affinity override changes one field without mutating caller state and rejects invalid keys', () => {
  const original = { prompt_cache_key: 'child', input: [{ content: 'synthetic' }] };
  assert.equal(applyProbeAffinity(original, {}), original);
  assert.deepEqual(applyProbeAffinity(original, { sessionId: 'child', cacheKeyOverride: 'parent' }),
    { ...original, prompt_cache_key: 'parent' });
  assert.equal(original.prompt_cache_key, 'child');
  for (const key of ['', 'child', 'x'.repeat(65), 42, null]) {
    assert.throws(() => applyProbeAffinity(original, { sessionId: 'child', cacheKeyOverride: key }));
  }
  assert.throws(() => applyProbeAffinity({}, { sessionId: 'child', cacheKeyOverride: 'parent' }));
});

test('affinity follow-up completes exactly eight scripted requests and compares paired effective payloads', async () => {
  const result = await runCacheProbe({ send, makeCases: affinityProbeCases, limits: AFFINITY_PROBE_LIMITS });
  assert.equal(result.status, 'completed');
  assert.equal(result.rows.length, 8);
  const pairs = result.rows.filter(r => r.variant === 'worker-parent-affinity');
  assert.equal(pairs.length, 2);
  for (const r of pairs) {
    assert.equal(r.previousComparison.fullInputPrefix, true);
    assert.equal(r.previousComparison.sameControlsExceptCacheKey, true);
    assert.equal(r.previousComparison.sameCacheKey, false);
    assert.equal(r.previousComparison.parentInputHash, r.previousComparison.childInputHash);
    assert.equal(r.comparison.sameCacheKey, true);
  }
});

test('raw usage requires explicit cached-token telemetry; missing does not become zero', () => {
  assert.equal(observedUsage(undefined), null);
  assert.equal(observedUsage({ ...rawUsage, input_tokens_details: {} }), null);
  assert.equal(observedUsage({ ...rawUsage, input_tokens_details: { cached_tokens: 999999 } }), null);
  assert.equal(observedUsage(rawUsage).uncachedInput, 960);
  assert.equal(observedUsage({ ...rawUsage, input_tokens_details: { cached_tokens: 0 } }).cacheRead, 0);
  assert.equal(summarizeProbe([{ status: 'completed', usage: observedUsage(rawUsage), apiEquivalentCost: null }]).apiEquivalentCost, null);
});

test('probe completes twelve scripted requests, saves intent before dispatch and returns only sanitized metadata', async () => {
  const snapshots = [];
  const result = await runCacheProbe({ send: async (s, h) => {
    assert.equal(snapshots.at(-1).rows.at(-1).status, 'started');
    return send(s, h);
  }, persist: r => snapshots.push(structuredClone(r)) });
  assert.equal(result.status, 'completed');
  assert.equal(result.rows.length, 12);
  assert.equal(result.summary.cacheRead, 23040 * 12);
  assert.equal(result.summary.subscriptionAllowanceUsed, null);
  assert.ok(!JSON.stringify(result).includes('Synthetic archival notes'));
});

test('probe stops on failed/unknown telemetry, retries, bad acknowledgement or oversized payload', async () => {
  for (const field of ['rawUsage', 'httpAttempts', 'acknowledged', 'stopReason', 'oversized']) {
    let attempts = 0;
    const result = await runCacheProbe({ send: async (s, h) => {
      attempts++;
      if (field === 'oversized') h.onPayload({ input: ['x'.repeat(PROBE_LIMITS.maxBodyBytes + 1)] });
      const r = await send(s, h);
      if (field === 'rawUsage') r.rawUsage = null;
      if (field === 'httpAttempts') r.httpAttempts = 2;
      if (field === 'acknowledged') r.acknowledged = false;
      if (field === 'stopReason') r.stopReason = 'error';
      return r;
    } });
    assert.equal(result.status, 'stopped', field);
    assert.equal(attempts, 1, field);
    assert.equal(result.summary.completed, 0);
  }
});

test('deadline aborts the probe; provider exception bodies never enter evidence', async () => {
  const result = await runCacheProbe({ limits: { ...PROBE_LIMITS, perRequestMs: 5 },
    send: async (_s, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Bearer SECRET_PROVIDER_BODY')));
    }) });
  assert.equal(result.status, 'stopped');
  assert.equal(result.stopReason, 'deadline');
  assert.doesNotMatch(JSON.stringify(result), /SECRET_PROVIDER_BODY/);
});

test('probe enforces total request budget even if a planner produces extra cases', async () => {
  const result = await runCacheProbe({ send, limits: { ...PROBE_LIMITS, requests: 2 } });
  assert.equal(result.status, 'stopped');
  assert.equal(result.stopReason, 'budget');
  assert.equal(result.rows.length, 2);
});

test('live entry point refuses execution without explicit --live consent', () => {
  for (const args of [[], ['--affinity-followup', '--out', 'unused.json']]) {
    assert.throws(() => execFileSync(process.execPath, ['scripts/pi-delegation-cache-probe.mjs', ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] }), error => /Explicit consent required/.test(error.stderr.toString()));
  }
});

test('installed OpenAI subscription-auth shape preserves tail prefix and omits unsupported effort updates',
  { skip: !process.env.PI_PACKAGE_ROOT }, async () => {
    const n = await loadDelegationNative(process.env.PI_PACKAGE_ROOT), model = n.models[1];
    const scenarios = probeCases(1);
    const base = await n.capture(model, scenarios[0].messages, scenarios[0].sessionId, true);
    const tail = await n.capture(model, scenarios[3].messages, scenarios[3].sessionId, true);
    assert.deepEqual(tail.input.slice(0, base.input.length), base.input);
    assert.notEqual(tail.prompt_cache_key, base.prompt_cache_key);
    assert.equal(base.input.some(item => item.type === 'configuration_update'), false);
    assert.equal(base.max_output_tokens, undefined);
    assert.equal(base.prompt_cache_options, undefined);
  });
