import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDelegationNative, payloadMatrix } from './helpers/delegation-native.mjs';
import { sdkWorker, syntheticExtension } from './helpers/delegation-sdk.mjs';
import { syntheticAssistant, syntheticTranscript, snapshotBeforeDispatch,
  assertCompleteToolPairs } from '../scripts/lib/delegation-context-spike.mjs';

const root = process.env.PI_PACKAGE_ROOT;
const native = root ? loadDelegationNative(root) : undefined;

test('installed adapter matrix: append-only candidates and prefix-breaking controls', { skip: !root }, async () => {
  const rows = await payloadMatrix(await native);
  for (const row of rows) {
    const positive = !['forced-head', 'no-mid-system-control'].includes(row.variant);
    const effortTailMoved = row.provider === 'openai' && positive && row.variant !== 'unchanged';
    assert.equal(row.fullInputPrefix && row.sameInstructions && row.sameControlsExceptCacheKey,
      positive && !effortTailMoved, `${row.provider}/${row.variant}`);
    if (effortTailMoved) assert.equal(row.commonItems, row.parentItems - 1);
    if (positive) {
      assert.equal(row.sameInstructions, true);
      assert.equal(row.sameTopLevelTools, true);
      assert.equal(row.sameControlsExceptCacheKey, true);
    }
    assert.equal(row.sameCacheKey, row.variant !== 'child-identity');
  }
});

test('tail tool removal is advisory in Responses input; current Pi tool state still removes it', { skip: !root }, async () => {
  const n = await native;
  for (const model of n.models) {
    const history = [...syntheticTranscript(model), { role: 'system', content: 'Notes scope.',
      toolsRemoved: [{ name: 'delegate' }], timestamp: 5 }];
    assert.ok(!n.getCurrentTools(history).some(t => t.name === 'delegate'));
    const body = await n.capture(model, history);
    assert.ok(body.input.some(item => item.type === 'additional_tools' &&
      item.tools.some(t => t.name === 'delegate')));
    assert.match(JSON.stringify(body.input), /no longer available/);
  }
});

test('native context projection honors compaction, edits and custom messages; separate in-memory child owns writes', { skip: !root }, async () => {
  const n = await native, model = n.models[0];
  const parent = n.SessionManager.inMemory(process.cwd());
  parent.appendModelChange(model.provider, model.id);
  parent.appendThinkingLevelChange('medium');
  const history = syntheticTranscript(model);
  parent.appendMessage(history[0]);
  const old = parent.appendMessage({ role: 'user', content: 'old source evidence', timestamp: 1 });
  const kept = parent.appendMessage({ role: 'user', content: 'original retained instruction', timestamp: 2 });
  parent.appendCompaction('old source was investigated', kept, 10000);
  parent.appendContextEdit(kept, { content: 'edited retained instruction' });
  const omitted = parent.appendMessage({ role: 'user', content: 'OMITTED_CONTEXT', timestamp: 3 });
  parent.appendContextEdit(omitted, null);
  parent.appendCustomMessageEntry('synthetic-note', 'custom context', false, { privateMetadata: 'not model input' });
  const checkpoint = parent.getLeafId();
  parent.appendMessage({ role: 'user', content: 'unrelated abandoned branch', timestamp: 6 });
  parent.branch(checkpoint);
  const entries = structuredClone(parent.getBranch());
  const child = n.SessionManager.inMemory(process.cwd(), { parentSession: 'synthetic-parent.jsonl' }, entries);
  const context = child.buildSessionContext();
  assert.equal(context.model.modelId, model.id);
  assert.equal(context.thinkingLevel, 'medium');
  const llm = n.convertToLlm(context.messages), text = JSON.stringify(llm);
  assert.match(text, /old source was investigated/);
  assert.match(text, /edited retained instruction/);
  assert.match(text, /custom context/);
  assert.doesNotMatch(text, /old source evidence|original retained instruction|abandoned branch|privateMetadata|OMITTED_CONTEXT/);
  assert.equal(parent.getEntry(old).message.content, 'old source evidence');
  assert.notEqual(child.getSessionId(), parent.getSessionId());
  child.appendMessage({ role: 'user', content: 'child-only assignment', timestamp: 7 });
  assert.equal(parent.getLeafId(), checkpoint);
  assert.doesNotMatch(JSON.stringify(parent.buildSessionContext()), /child-only/);
  assert.equal(child.getSessionFile(), undefined);
  child.getEntry(old).message.content = 'child-local mutation';
  assert.equal(parent.getEntry(old).message.content, 'old source evidence');
  assertCompleteToolPairs(llm);
  await n.capture(model, llm);
});

test('same-model signatures survive and dangling calls would be synthesized unless boundary is cut', { skip: !root }, async () => {
  const n = await native, model = n.models[0];
  const baseline = syntheticTranscript(model);
  baseline[2].content.unshift({ type: 'thinking', thinking: '', redacted: true,
    thinkingSignature: JSON.stringify({ type: 'reasoning', id: 'rs_synthetic',
      encrypted_content: 'SYNTHETIC_NOT_REAL_REASONING', summary: [] }) });
  const call = { type: 'toolCall', id: 'call_dispatch|fc_dispatch', name: 'delegate', arguments: { path: 'docs/PLAN.md' } };
  const pending = [...baseline, syntheticAssistant(model, [call], 'toolUse')];
  const unsafe = await n.capture(model, [...pending, { role: 'user', content: 'worker assignment', timestamp: 7 }]);
  assert.match(JSON.stringify(unsafe), /No result provided/);
  const safe = snapshotBeforeDispatch(pending, call.id).messages;
  const payload = await n.capture(model, safe);
  assert.doesNotMatch(JSON.stringify(payload), /No result provided/);
  assert.ok(payload.input.some(item => item.id === 'msg_synthetic'));
  assert.ok(payload.input.some(item => item.encrypted_content === 'SYNTHETIC_NOT_REAL_REASONING'));
  const other = { ...model, id: 'synthetic-other-model' };
  const foreign = await n.capture(other, baseline);
  assert.ok(!foreign.input.some(item => item.id === 'msg_synthetic'));
  assert.ok(!foreign.input.some(item => item.id === 'rs_synthetic'));
});

test('SDK child restores native entries, appends loadout changes, and ignores direct state injection', { skip: !root }, async () => {
  const n = await native, parent = n.SessionManager.inMemory(process.cwd());
  for (const m of syntheticTranscript(n.models[0])) parent.appendMessage(m);
  const leaf = parent.getLeafId();
  const child = n.SessionManager.inMemory(process.cwd(), undefined, structuredClone(parent.getBranch()));
  const h = await sdkWorker(n, child);
  try {
    assert.notEqual(h.session.sessionId, parent.getSessionId());
    h.session.agent.state.messages.push({ role: 'user', content: 'UNPERSISTED_INJECTION', timestamp: 7 });
    await h.session.prompt('Update our notes.', { expandPromptTemplates: false });
    assert.equal(h.requests.length, 1);
    const request = h.requests[0];
    assert.equal(request.model.id, n.models[0].id);
    assert.equal(request.reasoning, 'medium');
    assert.equal(request.sessionId, child.getSessionId());
    assert.doesNotMatch(JSON.stringify(request.context), /UNPERSISTED_INJECTION/);
    const parentBody = await n.capture(n.models[0], n.convertToLlm(parent.buildSessionContext().messages));
    const childBody = await n.capture(n.models[0], request.context.messages);
    assert.deepEqual(childBody.input.slice(0, parentBody.input.length), parentBody.input);
    assert.equal(childBody.instructions, parentBody.instructions);
    assert.equal(parent.getLeafId(), leaf);
    assert.equal(parent.getSessionFile(), undefined);
  } finally { h.session.dispose(); }
});

test('SDK context hooks are request-local; tool-call guard blocks a declared forbidden tool', { skip: !root }, async () => {
  const n = await native, sm = n.SessionManager.inMemory(process.cwd()), model = n.models[0];
  for (const m of syntheticTranscript(model)) sm.appendMessage(m);
  const extension = syntheticExtension({
    context_with_system: event => ({ messages: [...event.messages,
      { role: 'system', content: 'REQUEST_LOCAL_ONLY', timestamp: 8 }] }),
    tool_call: event => event.toolName === 'edit' ? { block: true, reason: 'Notes policy blocked this edit' } : undefined,
  });
  const h = await sdkWorker(n, sm, { extensions: [extension], replies: [syntheticAssistant(model,
    [{ type: 'toolCall', name: 'edit', id: 'call_block|fc_block', arguments: { path: 'src/code.ts' } }], 'toolUse')] });
  try {
    await h.session.prompt('Synthetic permission test.', { expandPromptTemplates: false });
    assert.equal(h.requests.length, 2);
    assert.match(JSON.stringify(h.requests[0].context), /REQUEST_LOCAL_ONLY/);
    assert.doesNotMatch(JSON.stringify(sm.buildSessionContext()), /REQUEST_LOCAL_ONLY/);
    assert.equal(h.executions(), 0);
    const toolResult = sm.buildSessionContext().messages.find(m => m.role === 'toolResult');
    assert.equal(toolResult.isError, true);
    assert.match(JSON.stringify(toolResult), /Notes policy blocked/);
  } finally { h.session.dispose(); }
});

for (const mode of ['forced-prompt', 'context-copy']) {
  test(`SDK negative control: ${mode} breaks or collapses the inherited prompt prefix`, { skip: !root }, async () => {
    const n = await native, sm = n.SessionManager.inMemory(process.cwd()), model = n.models[0];
    for (const m of syntheticTranscript(model)) sm.appendMessage(m);
    const before = await n.capture(model, n.convertToLlm(sm.buildSessionContext().messages));
    const handlers = mode === 'forced-prompt'
      ? { before_agent_start: () => ({ systemPrompt: 'Forced replacement prompt.' }) }
      : { context: event => ({ messages: event.messages.map(m => structuredClone(m)) }) };
    const h = await sdkWorker(n, sm, { extensions: [syntheticExtension(handlers)] });
    try {
      await h.session.prompt('Update notes.', { expandPromptTemplates: false });
      const after = await n.capture(model, h.requests[0].context.messages);
      assert.notEqual(before.instructions, after.instructions);
      assert.ok(h.requests[0].context.messages.filter(m => m.role === 'system').length === 1);
    } finally { h.session.dispose(); }
  });
}
