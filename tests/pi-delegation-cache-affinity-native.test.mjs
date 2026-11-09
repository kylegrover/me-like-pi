import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as zlib from 'node:zlib';
import { loadDelegationNative } from './helpers/delegation-native.mjs';
import { probeCases, applyProbeAffinity } from '../scripts/lib/delegation-cache-probe.mjs';

const root = process.env.PI_PACKAGE_ROOT;
const native = root ? loadDelegationNative(root) : undefined;

for (const provider of ['openai', 'openai-codex']) {
  test(`${provider}: payload-only affinity keeps worker headers independent (offline wire capture)`,
    { skip: !root }, async () => {
      const n = await native, model = n.models.find(m => m.provider === provider);
      const adapter = await n.ai(`api/${model.api}.js`);
      const cases = probeCases(1);
      const parentKey = 'synthetic-parent-affinity', workerId = 'synthetic-worker-identity';
      const jwt = `synthetic.${Buffer.from(JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' },
      })).toString('base64url')}.not-a-signature`;
      let original, wire, attempts = 0;
      const result = await adapter.stream(model, { messages: cases[3].messages }, {
        apiKey: jwt, sessionId: workerId, transport: 'sse', maxRetries: 0,
        reasoningEffort: 'medium',
        onPayload(payload) {
          original = structuredClone(payload);
          // Supported adapter hook: do not change Agent/session IDs or global state.
          return applyProbeAffinity(payload, { sessionId: workerId, cacheKeyOverride: parentKey });
        },
        async fetch(input, init) {
          attempts++;
          const headers = new Headers(init.headers);
          const body = headers.get('content-encoding') === 'zstd'
            ? zlib.zstdDecompressSync(init.body).toString('utf8') : init.body;
          wire = { body: JSON.parse(body), headers };
          throw new Error('OFFLINE_WIRE_CAPTURE'); // Never call global fetch.
        },
      }).result();
      assert.equal(result.stopReason, 'error');
      assert.equal(attempts, 1);
      assert.ok(wire);
      assert.equal(original.prompt_cache_key, workerId);
      assert.equal(wire.body.prompt_cache_key, parentKey);
      // Legacy Codex spells the header with a hyphen; newer OpenAI uses underscore.
      const sessionHeader = provider === 'openai' ? 'session_id' : 'session-id';
      assert.equal(wire.headers.get(sessionHeader), workerId);
      assert.equal(wire.headers.get('x-client-request-id'), workerId);
      assert.deepEqual(wire.body, JSON.parse(JSON.stringify({ ...original, prompt_cache_key: parentKey })));
      assert.equal(wire.body.previous_response_id, undefined);
      assert.notEqual(wire.headers.get(sessionHeader), parentKey);
    });
}
