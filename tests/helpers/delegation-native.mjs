// Native Pi adapter capture with deliberately fake credentials. No network.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { piDependency } from './pi-package.mjs';
import { comparePayloads, syntheticTranscript } from '../../scripts/lib/delegation-context-spike.mjs';

export async function loadDelegationNative(root) {
  const native = file => import(pathToFileURL(resolve(root, file)).href);
  const ai = file => native(piDependency(root, '@earendil-works/pi-ai', `dist/${file}`));
  const [{ OPENAI_CODEX_MODELS }, { OPENAI_MODELS }, codex, openai, transcript, messages, manager] =
    await Promise.all([
      ai('providers/openai-codex.models.js'), ai('providers/openai.models.js'),
      ai('api/openai-codex-responses.js'), ai('api/openai-responses.js'),
      ai('utils/transcript.js'), native('dist/core/messages.js'), native('dist/core/session-manager.js'),
    ]);
  const models = [OPENAI_CODEX_MODELS['gpt-6-astra'], OPENAI_MODELS['gpt-6-astra']];
  assert.ok(models.every(Boolean), 'Pinned Astra models missing; re-review catalog');
  const fakeJwt = `synthetic.${Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' },
  })).toString('base64url')}.not-a-signature`;
  async function capture(model, history, sessionId = 'synthetic-parent', subscription = false, streamOptions = {}) {
    let payload, networkCalls = 0;
    const adapter = model.api === 'openai-codex-responses' ? codex : openai;
    const result = await adapter.stream(model, { messages: history }, {
      apiKey: model.api === 'openai-codex-responses' || subscription ? fakeJwt : 'sk-synthetic-not-a-key',
      sessionId, transport: 'sse', maxRetries: 0, reasoningEffort: 'medium', ...streamOptions,
      fetch: async () => { networkCalls++; throw new Error('NETWORK FORBIDDEN'); },
      onPayload(body) {
        payload = structuredClone(body);
        throw new Error('S1_CAPTURE_ONLY'); // Before adapter transport sends anything.
      },
    }).result();
    assert.equal(networkCalls, 0);
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /S1_CAPTURE_ONLY/);
    assert.ok(payload, 'Payload hook was not reached');
    return payload;
  }
  return { native, ai, models, capture, ...transcript, ...messages, ...manager };
}

export async function payloadMatrix(n) {
  const rows = [];
  for (const model of n.models) {
    const base = syntheticTranscript(model);
    const assignment = { role: 'user', content: 'Update our notes. Return only a receipt.', timestamp: 5 };
    const tail = { role: 'system', content: 'Worker: notes-only writes; no shell, delegation or network.',
      toolsRemoved: [{ name: 'delegate' }], timestamp: 5 };
    const parent = await n.capture(model, base);
    const variants = [
      ['unchanged', base, 'synthetic-parent'],
      ['assignment', [...base, assignment], 'synthetic-parent'],
      ['tail-instructions-and-removal', [...base, tail, assignment], 'synthetic-parent'],
      ['child-identity', [...base, tail, assignment], 'synthetic-child'],
      ['forced-head', [{ ...base[0], content: 'Replacement worker instructions.', sections: {} },
        ...base.slice(1), assignment], 'synthetic-parent'],
    ];
    for (const [variant, history, key] of variants) {
      rows.push({ provider: model.provider, variant, ...comparePayloads(parent, await n.capture(model, history, key)) });
    }
    const collapsedModel = { ...model, compat: { ...model.compat, supportsMidConvoSystemMessages: false } };
    const collapsedParent = await n.capture(collapsedModel, base);
    rows.push({ provider: model.provider, variant: 'no-mid-system-control',
      ...comparePayloads(collapsedParent, await n.capture(collapsedModel, [...base, tail, assignment])) });
  }
  return rows;
}
