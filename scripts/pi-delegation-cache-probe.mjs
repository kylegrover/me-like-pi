// LIVE only with --live --out <new-file>. Uses Pi's native subscription OAuth path.
// No parent transcript, real notes, filesystem tools, API-key fallback or retries.
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCacheProbe, PROBE_LIMITS, AFFINITY_PROBE_LIMITS, probeCases,
  affinityProbeCases, applyProbeAffinity } from './lib/delegation-cache-probe.mjs';
import { digest } from './lib/delegation-context-spike.mjs';

const args = process.argv.slice(2);
const affinity = args[1] === '--affinity-followup';
const outputArgs = args.slice(affinity ? 2 : 1);
if (args[0] !== '--live' || outputArgs.length !== 2 || outputArgs[0] !== '--out') {
  throw new Error('Explicit consent required: --live [--affinity-followup] --out <new report file>. No requests made.');
}
const limits = affinity ? AFFINITY_PROBE_LIMITS : PROBE_LIMITS;
const root = process.env.PI_PACKAGE_ROOT;
if (!root) throw new Error('Set PI_PACKAGE_ROOT explicitly.');
const output = resolve(outputArgs[1]);
if (existsSync(output) || existsSync(`${output}.partial`)) throw new Error('Refusing to overwrite prior evidence.');
const native = file => import(pathToFileURL(resolve(root, file)).href);
const [{ ModelRuntime }, { AuthStorage }] = await Promise.all([
  native('dist/core/model-runtime.js'), native('dist/core/auth-storage.js'),
]);
const backing = AuthStorage.create();
const credentials = {
  async read(provider, options) {
    if (provider !== 'openai') return undefined;
    const credential = await backing.read(provider, options);
    if (credential?.type !== 'oauth') throw new Error('Stored subscription OAuth required; no API-key fallback.');
    return credential;
  },
  async list(options) { return (await backing.list(options)).filter(c => c.providerId === 'openai' && c.type === 'oauth'); },
  async modify(provider, fn, options) {
    if (provider !== 'openai') throw new Error('Unexpected credential mutation');
    return backing.modify(provider, async current => {
      if (current?.type !== 'oauth') throw new Error('Subscription OAuth required');
      const next = await fn(current);
      if (next?.type !== 'oauth') throw new Error('Refusing credential-type change');
      return next;
    }, options);
  },
  async delete() { throw new Error('Credential deletion forbidden'); },
};
const runtime = await ModelRuntime.create({ credentials, modelsPath: null,
  allowModelNetwork: false, refreshOnCreate: false });
await runtime.refresh({ allowNetwork: false, providers: ['openai'], signal: AbortSignal.timeout(15000) });
if (!runtime.isUsingOAuth('openai') || !runtime.isUsingSubscription('openai')) {
  throw new Error('Subscription OAuth not resolved; no requests made.');
}
const model = runtime.getPhysicalModel('openai', 'gpt-6-astra');
if (!model || model.api !== 'openai-responses' || model.baseUrl !== 'https://api.openai.com/v1') {
  throw new Error('Unexpected model endpoint; no requests made.');
}
const piVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const metadata = { piVersion, nodeVersion: process.version,
  probe: affinity ? 'split-cache-affinity' : 'identity-baseline',
  provider: model.provider, model: model.id, api: model.api,
  authentication: 'stored ChatGPT subscription OAuth; API-key fallback refused',
  transport: 'SSE (native openai-responses subscription path)', thinking: 'medium',
  data: 'generated synthetic archive only',
  limitsNote: 'No verified provider hard output-token cap on subscription auth; acknowledgement requested.',
};
mkdirSync(dirname(output), { recursive: true });
let totalAttempts = 0;
const report = await runCacheProbe({
  limits, makeCases: affinity ? affinityProbeCases : probeCases,
  async persist(state) {
    const snapshot = { ...metadata, ...state, totalHttpAttempts: totalAttempts };
    writeFileSync(`${output}.partial`, `${JSON.stringify(snapshot, null, 2)}\n`);
    renameSync(`${output}.partial`, output);
  },
  progress(row) {
    console.log(`${row.cohort}/${row.variant}: ${row.status}; input=${row.usage?.totalInput ?? '?'} cached=${row.usage?.cacheRead ?? '?'} elapsed=${row.elapsedMs}ms`);
  },
  async send(scenario, hooks) {
    let httpAttempts = 0, httpStatus, rawUsage, wire, capturedHash;
    const result = await runtime.completeSimple(model, { messages: scenario.messages }, {
      reasoning: 'medium', sessionId: scenario.sessionId, signal: hooks.signal,
      maxRetries: 0, timeoutMs: limits.perRequestMs, cacheRetention: 'short',
      identity: { userAgent: 'detailed', version: piVersion, attribution: null },
      onPayload(payload) {
        const effective = applyProbeAffinity(payload, scenario);
        hooks.onPayload(effective);
        capturedHash = digest(effective);
        return effective;
      },
      onResponse(response) { httpStatus = response.status; },
      onProviderStreamEvent(event) {
        if (['response.completed', 'response.done', 'response.incomplete'].includes(event.type)) {
          rawUsage = event.response?.usage;
        }
      },
      async fetch(input, init) {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        const headers = new Headers(init?.headers ?? input.headers);
        const auth = headers.get('authorization') ?? '';
        if (url.origin !== 'https://api.openai.com' || url.pathname !== '/v1/responses' ||
          !auth.startsWith('Bearer ') || /^Bearer sk-/i.test(auth)) throw new Error('Unexpected endpoint/auth');
        // Check actual transmitted fields, not just pre-serialization callback observations.
        const body = JSON.parse(init.body);
        wire = { workerSessionHeader: headers.get('session_id') === scenario.sessionId,
          workerRequestHeader: headers.get('x-client-request-id') === scenario.sessionId,
          cacheKeyMatchesPlan: body.prompt_cache_key === (scenario.cacheKeyOverride ?? scenario.sessionId),
          cacheKeyMatchesWorker: body.prompt_cache_key === scenario.sessionId,
          payloadMatchesCapture: digest(body) === capturedHash,
          bodyBytes: Buffer.byteLength(init.body) };
        if (!wire.workerSessionHeader || !wire.workerRequestHeader || !wire.cacheKeyMatchesPlan ||
          !wire.payloadMatchesCapture || wire.bodyBytes > limits.maxBodyBytes) throw new Error('Wire contract failed');
        if (++httpAttempts !== 1 || ++totalAttempts > limits.requests) throw new Error('Request budget exceeded');
        return globalThis.fetch(input, { ...init, redirect: 'error' });
      },
    });
    const text = result.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    return { httpAttempts, httpStatus, rawUsage, wire, cost: result.usage?.cost?.total,
      stopReason: result.stopReason, acknowledged: text === 'OK' };
  },
});
console.log(`Probe ${report.status}: ${report.summary.completed} completed; ${totalAttempts} HTTP attempts. Evidence: ${outputArgs[1]}`);
if (report.status !== 'completed') process.exitCode = 1;
