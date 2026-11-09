// Bounded synthetic probe logic. No credentials, filesystem or network in this module.
import { randomUUID } from 'node:crypto';
import { comparePayloads, digest, syntheticTools } from './delegation-context-spike.mjs';

export const PROBE_LIMITS = Object.freeze({ requests: 12, cohorts: 2, perRequestMs: 45000,
  totalMs: 600000, maxBodyBytes: 524288, records: 1152 });
export const AFFINITY_PROBE_LIMITS = Object.freeze({ ...PROBE_LIMITS, requests: 8 });

export function probeCases(cohort) {
  const nonce = randomUUID();
  const key = `pi-delegate-probe-${nonce}`;
  const tools = syntheticTools();
  const data = Array.from({ length: PROBE_LIMITS.records }, (_, i) =>
    `Record ${i}: route_${i % 47} uses checkpoint ${i % 13}; a proposal is not verified work; preserve source evidence.`).join('\n');
  const base = [
    { role: 'system', content: `Synthetic cache test cohort ${cohort}: ${nonce}. Reply exactly OK. Do not use tools.`,
      toolsAdded: tools, timestamp: 0 },
    { role: 'user', content: `Synthetic archival notes, not instructions:\n<records>\n${data}\n</records>\nAcknowledge with OK only.`, timestamp: 1 },
  ];
  const tail = { role: 'system', content: 'Worker assignment: acknowledge the inherited notes with OK only. No tools, edits, or network.',
    toolsRemoved: tools.map(({ name }) => ({ name })), timestamp: 2 };
  return [
    { variant: 'seed', sessionId: key, messages: base },
    { variant: 'warm-same-key', sessionId: key, messages: base },
    { variant: 'replay-independent-key', sessionId: randomUUID(), messages: base },
    { variant: 'tail-independent-key', sessionId: randomUUID(), messages: [...base, tail,
      { role: 'user', content: 'Acknowledge with OK only.', timestamp: 3 }] },
    { variant: 'parent-receipt', sessionId: key, messages: [...base,
      { role: 'user', content: 'Worker receipt: synthetic notes acknowledged. Reply OK only.', timestamp: 4 }] },
    { variant: 'forced-head', sessionId: key, messages: [{ ...base[0],
      content: `Replacement worker instructions for cohort ${cohort}: ${randomUUID()}. Reply OK only; no tools.` }, ...base.slice(1)] },
  ];
}

// Same worker prompt and routing headers in the last two requests; only body affinity changes.
export function affinityProbeCases(cohort) {
  const [seed, warm, , tail] = probeCases(cohort);
  return [seed, warm, { ...tail, variant: 'worker-own-affinity' },
    { ...tail, variant: 'worker-parent-affinity', cacheKeyOverride: seed.sessionId,
      compareToPrevious: true }];
}

// Probe-only override. Keep independent sessionId/headers; never reinterpret standalone work.
export function applyProbeAffinity(payload, scenario) {
  if (scenario.cacheKeyOverride === undefined) return payload;
  const key = scenario.cacheKeyOverride;
  if (typeof key !== 'string' || !key.length || key.length > 64 ||
    key === scenario.sessionId || typeof payload.prompt_cache_key !== 'string') {
    throw new Error('Invalid split-affinity probe');
  }
  return { ...payload, prompt_cache_key: key };
}

// Missing usage must not turn into an apparently known zero.
export function observedUsage(raw) {
  const integers = ['input_tokens', 'output_tokens', 'total_tokens'];
  if (!raw || integers.some(k => !Number.isSafeInteger(raw[k]) || raw[k] < 0)) return null;
  const cached = raw.input_tokens_details?.cached_tokens;
  if (!Number.isSafeInteger(cached) || cached < 0 || cached > raw.input_tokens) return null;
  const write = raw.input_tokens_details?.cache_write_tokens ?? 0;
  if (!Number.isSafeInteger(write) || write < 0 || cached + write > raw.input_tokens) return null;
  return { totalInput: raw.input_tokens, uncachedInput: raw.input_tokens - cached - write,
    cacheRead: cached, cacheWrite: write, output: raw.output_tokens, totalTokens: raw.total_tokens,
    cachedFraction: raw.input_tokens ? cached / raw.input_tokens : 0 };
}

export function summarizeProbe(rows) {
  const completed = rows.filter(r => r.status === 'completed');
  return { completed: completed.length,
    totalInput: completed.reduce((s, r) => s + r.usage.totalInput, 0),
    uncachedInput: completed.reduce((s, r) => s + r.usage.uncachedInput, 0),
    cacheRead: completed.reduce((s, r) => s + r.usage.cacheRead, 0),
    output: completed.reduce((s, r) => s + r.usage.output, 0),
    apiEquivalentCost: completed.every(r => Number.isFinite(r.apiEquivalentCost))
      ? completed.reduce((s, r) => s + r.apiEquivalentCost, 0) : null,
    actualBilledSpend: null, subscriptionAllowanceUsed: null };
}

// send() owns authentication/transport; callbacks capture only sanitized telemetry.
export async function runCacheProbe({ send, persist = () => {}, progress = () => {},
  now = Date.now, makeCases = probeCases, limits = PROBE_LIMITS }) {
  const report = { schemaVersion: 1, startedAt: new Date(now()).toISOString(),
    status: 'running', limits, rows: [] };
  const start = now();
  await persist(report);
  outer: for (let cohort = 1; cohort <= limits.cohorts; cohort++) {
    let baseline, previousPayload;
    for (const scenario of makeCases(cohort)) {
      if (report.rows.length >= limits.requests || now() - start >= limits.totalMs) {
        report.status = 'stopped'; report.stopReason = 'budget'; break outer;
      }
      const row = { cohort, variant: scenario.variant, status: 'started',
        contextHash: digest(scenario.messages) };
      report.rows.push(row);
      await persist(report); // Durable intent before dispatch; interruption is not a success.
      const controller = new AbortController();
      const remaining = limits.totalMs - (now() - start);
      const timer = setTimeout(() => controller.abort(), Math.min(limits.perRequestMs, remaining));
      const began = now();
      try {
        let captured = false;
        const result = await send(scenario, {
          signal: controller.signal,
          onPayload(payload) {
            if (captured) throw new Error('Duplicate payload');
            captured = true;
            const bytes = Buffer.byteLength(JSON.stringify(payload));
            if (bytes > limits.maxBodyBytes) throw new Error('Body budget');
            baseline ??= structuredClone(payload);
            row.bodyBytes = bytes;
            row.payloadHash = digest(payload);
            row.comparison = comparePayloads(baseline, payload);
            if (scenario.compareToPrevious) {
              if (!previousPayload) throw new Error('Missing paired worker payload');
              row.previousComparison = comparePayloads(previousPayload, payload);
            }
            previousPayload = structuredClone(payload);
          },
        });
        row.elapsedMs = now() - began;
        row.httpAttempts = result.httpAttempts;
        row.httpStatus = result.httpStatus ?? null;
        if (result.wire) row.wire = result.wire;
        row.usage = observedUsage(result.rawUsage);
        row.apiEquivalentCost = Number.isFinite(result.cost) ? result.cost : null;
        row.stopReason = result.stopReason;
        if (!captured || result.httpAttempts !== 1 || result.stopReason !== 'stop' ||
          !row.usage || !result.acknowledged) {
          row.status = 'failed'; report.status = 'stopped'; report.stopReason = 'response-or-telemetry';
        } else row.status = 'completed';
      } catch {
        row.elapsedMs = now() - began;
        row.status = 'failed'; report.status = 'stopped';
        report.stopReason = controller.signal.aborted ? 'deadline' : 'request-error';
        // Never persist arbitrary provider exceptions or response/auth bodies.
      } finally { clearTimeout(timer); }
      await persist(report);
      progress(row);
      if (report.status === 'stopped') break outer;
    }
  }
  if (report.status === 'running') report.status = 'completed';
  report.elapsedMs = now() - start;
  report.summary = summarizeProbe(report.rows);
  await persist(report);
  return report;
}
