import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoffHarness } from './helpers/handoff-harness.mjs';
import { stepDownModel } from '../extensions/lib/pi-handoff.ts';

const history = (h, args) => h.tools.get('handoff_history').execute('tool', args, undefined, undefined, h.ctx);
const flush = () => new Promise(resolve => setImmediate(resolve));
const explicitWorker = '--model openai-codex/gpt-6-luna --thinking xhigh -- Change only example.txt; validate, then stop.';

test('step-down ladder: newest model one tier lower on the same provider only', () => {
  const refs = ['openai-codex/gpt-6-sol', 'openai-codex/gpt-6.1-sol', 'openai-codex/gpt-6.1-terra',
    'openai-codex/gpt-6-luna', 'openai/gpt-6.1-terra', 'claude-code/claude-sonnet-5', 'claude-code/claude-sonnet-5-5',
    'claude-code/claude-haiku-4-5-20251001', 'claude-code/claude-haiku-5-5', 'claude-code/default']
    .map(r => { const [provider, id] = r.split('/'); return { provider, id }; });
  const down = (provider, id) => { const m = stepDownModel({ provider, id }, refs); return m && `${m.provider}/${m.id}`; };
  assert.equal(down('openai-codex', 'gpt-6-astra'), 'openai-codex/gpt-6.1-sol');
  assert.equal(down('openai-codex', 'gpt-6.1-sol'), 'openai-codex/gpt-6.1-terra');
  assert.equal(down('openai', 'gpt-6.1-sol'), 'openai/gpt-6.1-terra');
  assert.equal(down('openai-codex', 'gpt-6.1-terra'), 'openai-codex/gpt-6-luna');
  assert.equal(down('claude-code', 'claude-opus-5-5'), 'claude-code/claude-sonnet-5-5');
  assert.equal(down('claude-code', 'claude-sonnet-5-5'), 'claude-code/claude-haiku-5-5');
  for (const [p, id] of [['openai-codex', 'gpt-6-luna'], ['claude-code', 'claude-haiku-5-5'],
    ['claude-code', 'default'], ['anthropic', 'claude-opus-5-5'], ['openai', 'gpt-5.5']]) assert.equal(down(p, id), undefined, id);
});

test('handoff: exact checkpoint, read-only Git capture, default step-down at xhigh and bounded prompt', async () => {
  const h = handoffHarness(); await h.start();
  assert.equal(h.saved().phase, 'working');
  assert.equal(h.ctx.model.id, 'gpt-6.1-sol'); assert.equal(h.pi.getThinkingLevel(), 'xhigh');
  assert.deepEqual(h.saved().worker, { provider: 'openai-codex', id: 'gpt-6.1-sol' });
  assert.equal(h.saved().workerThinking, 'xhigh');
  assert.deepEqual(h.models, ['gpt-6.1-sol']); assert.deepEqual(h.thinkingChanges, ['xhigh']);
  assert.equal(h.sm.getEntry(h.saved().checkpointId).type, 'custom');
  assert.equal(h.saved().origin.id, 'gpt-6-astra'); assert.equal(h.saved().thinking, 'medium');
  assert.match(h.saved().git.status, /user-owned/); assert.equal(h.saved().git.statusSha256.length, 64);
  assert.equal(h.sent.length, 1); assert.match(h.sent[0], /No commit/);
  assert.ok(h.gitCalls.every(c => c.command === 'git' && c.args[0] === '--no-optional-locks'));
  await h.command('handoff', 'nested'); assert.equal(h.sent.length, 1);
  await h.command('closeout'); assert.equal(h.sent.length, 1);
});

test('handback: exact visible final answer, native summary, original model/thinking, review once', async () => {
  const h = handoffHarness(); await h.start();
  const original = await h.finish({ thinkingBlock: true });
  assert.equal(h.saved().phase, 'returned');
  assert.equal(h.ctx.model.id, 'gpt-6-astra'); assert.equal(h.pi.getThinkingLevel(), 'medium');
  assert.equal(h.summaries.length, 1); assert.ok(h.summaries[0].endsWith(original.text));
  assert.ok(!h.summaries[0].includes('thinking omitted'));
  assert.match(h.summaries[0], /sessionFile/); assert.match(h.summaries[0], /handoff_history/);
  assert.match(h.summaries[0], /does NOT undo/);
  assert.equal(h.saved().answerId, original.entryId);
  assert.ok(!h.sm.getBranch().some(e => e.id === original.entryId));
  assert.ok(h.sm.getEntry(original.entryId));
  assert.equal(h.sent.length, 3); assert.match(h.sent[2], /^Review the handback/);
  await h.command('handback'); await h.emit('agent_settled'); assert.equal(h.sent.length, 3);
});

test('history: branch-scoped literal search, paging and long entry recovery without navigation', async () => {
  const h = handoffHarness();
  const before = h.sm.appendMessage({ role: 'user', content: 'outside worker evidence' });
  await h.start();
  const long = h.sm.appendMessage({ role: 'toolResult', content: [{ type: 'text', text: 'fixture ' + 'x'.repeat(17000) }] });
  await h.finish();
  const leaf = h.sm.getLeafId(), runId = h.saved().runId;
  let result = await history(h, { runId, query: 'FIXTURE', limit: 1 });
  assert.match(result.content[0].text, /nextOffset/); assert.match(result.content[0].text, /fixture/);
  result = await history(h, { runId, entryId: long });
  assert.ok(result.content[0].text.length < 8500); assert.match(result.content[0].text, /"nextOffset":8000/);
  result = await history(h, { runId, entryId: long, offset: 16000 });
  assert.match(result.content[0].text, /"nextOffset":null/);
  await assert.rejects(history(h, { runId, entryId: before }), /not in this worker span/);
  await assert.rejects(history(h, { runId: 'other' }), /No saved worker/);
  assert.equal(h.sm.getLeafId(), leaf);
});

test('worker check-ins/model selection are allowed; busy handback does not discard checkpoint', async () => {
  const h = handoffHarness(); await h.start();
  await h.emit('input', { source: 'interactive', text: 'also inspect this test' });
  await h.emit('before_agent_start', { prompt: 'also inspect this test' });
  h.setIdle(false); await h.command('handback'); h.setIdle(true);
  h.setPending(true); await h.command('handback'); h.setPending(false);
  assert.equal(h.saved().phase, 'working'); assert.equal(h.sent.length, 1);
  h.setThinking('high');
  await h.finish(); assert.equal(h.saved().phase, 'returned');
});

test('Git failure and missing model auth never dispatch worker task; clamped thinking also stops', async () => {
  for (const flag of ['gitError', 'setModelError', 'thinkingClamp']) {
    const h = handoffHarness(); h.controls[flag] = true; await h.start(explicitWorker);
    assert.equal(h.sent.length, 0, flag); assert.equal(h.saved().phase, 'stopped', flag);
  }
});

test('stop during asynchronous Git capture suppresses later switch/send', async () => {
  const h = handoffHarness(); let resolve;
  h.controls.gitDelay = new Promise(r => { resolve = r; });
  const task = h.start(); await h.command('sprint-stop'); resolve(); await task;
  assert.equal(h.sent.length, 0); assert.equal(h.models.length, 0);
});

test('stopped asynchronous model change cannot dispatch worker after it completes', async () => {
  const h = handoffHarness(); let resolve;
  h.controls.modelDelay = new Promise(r => { resolve = r; });
  const task = h.start(explicitWorker); await flush(); await h.command('sprint-stop'); resolve(); await task;
  assert.equal(h.sent.length, 0); assert.equal(h.saved().phase, 'stopped');
});

test('aborted/truncated/error/unready final answer never navigates or restores', async () => {
  for (const options of [{ ready: false }, { stopReason: 'aborted' }, { stopReason: 'length' }, { stopReason: 'error' }]) {
    const h = handoffHarness(); await h.start(); await h.finish(options);
    assert.equal(h.summaries.length, 0); assert.equal(h.ctx.model.id, 'gpt-6.1-sol');
    assert.equal(h.sent.length, 2); assert.equal(h.saved().phase, 'stopped');
  }
});

test('external input, model/thinking, tree, session replacement, tool errors stop packet preparation', async () => {
  for (const [event, data] of [
    ['input', { source: 'interactive', text: 'wait' }],
    ['before_agent_start', { prompt: 'other work' }],
    ['before_agent_start', { messageType: 'custom', message: { customType: 'other-work' } }],
    ['model_select', { model: { provider: 'test', id: 'other' } }], ['thinking_level_select', {}],
    ['session_before_tree', { preparation: { targetId: 'other' } }],
    ['session_before_switch', {}], ['session_before_fork', {}],
    ['tool_result', { isError: true }], ['session_before_compact', { reason: 'manual' }],
  ]) {
    const h = handoffHarness(); await h.start(); const task = h.command('handback');
    await h.emit(event, data); h.answer(); await h.emit('agent_settled'); await task;
    assert.equal(h.summaries.length, 0, event); assert.equal(h.sent.length, 2, event);
  }
});

test('own packet prompt and automatic compaction are accepted', async () => {
  const h = handoffHarness(); await h.start(); const task = h.command('handback');
  await h.emit('input', { source: 'extension', text: h.sent.at(-1) });
  await h.emit('before_agent_start', { prompt: h.sent.at(-1) });
  await h.emit('session_before_compact', { reason: 'threshold' });
  h.answer(); await h.emit('agent_settled'); await task;
  assert.equal(h.saved().phase, 'returned');
});

test('cancelled/tampered tree return or failed restoration cannot start review', async () => {
  for (const flag of ['treeCancel', 'treeTamper', 'setModelError']) {
    const h = handoffHarness(); await h.start(explicitWorker); h.controls[flag] = true; await h.finish();
    assert.equal(h.sent.length, 2, flag); assert.equal(h.saved().phase, 'stopped', flag);
    assert.ok(h.saved().answerId, flag); // Exact answer still retrievable even on failed return.
    const result = await history(h, { runId: h.saved().runId, entryId: h.saved().answerId });
    assert.match(result.content[0].text, /Completed bounded/);
  }
});

test('stop during native navigation suppresses late review', async () => {
  const h = handoffHarness(); await h.start(); let resolve;
  h.controls.treeDelay = new Promise(r => { resolve = r; });
  const task = h.command('handback'); h.answer(); await h.emit('agent_settled'); await flush();
  await h.command('sprint-stop'); resolve(); await task;
  assert.equal(h.sent.length, 2); assert.equal(h.saved().phase, 'stopped');
});

test('reload restores only the working checkpoint, never sends a prompt automatically', async () => {
  const h = handoffHarness(); await h.start(); await h.reload();
  assert.equal(h.sent.length, 1); await h.finish(); assert.equal(h.saved().phase, 'returned');
  await h.reload(); await h.command('handback'); assert.equal(h.sent.length, 3);
});

test('explicit worker model/reasoning overrides preserve and restore review settings', async () => {
  const h = handoffHarness(); await h.start(explicitWorker);
  assert.equal(h.saved().phase, 'working');
  assert.deepEqual(h.saved().worker, { provider: 'openai-codex', id: 'gpt-6-luna' });
  assert.equal(h.saved().workerThinking, 'xhigh');
  assert.equal(h.saved().assignment, 'Change only example.txt; validate, then stop.');
  assert.equal(h.pi.getThinkingLevel(), 'xhigh');
  await h.finish();
  assert.equal(h.ctx.model.id, 'gpt-6-astra'); assert.equal(h.pi.getThinkingLevel(), 'medium');
  assert.deepEqual(h.models, ['gpt-6-luna', 'gpt-6-astra']);
});

test('explicit current model with reasoning override needs no model reset and restores effort', async () => {
  const h = handoffHarness(); await h.start('--model openai-codex/gpt-6-astra --thinking high -- inspect only');
  assert.equal(h.pi.getThinkingLevel(), 'high'); assert.equal(h.saved().workerThinking, 'high');
  assert.deepEqual(h.models, []);
  await h.finish();
  assert.equal(h.pi.getThinkingLevel(), 'medium'); assert.deepEqual(h.models, []);
  assert.deepEqual(h.thinkingChanges, ['high', 'medium']);
});

test('Claude Opus steps down to newest Sonnet at xhigh and restores Opus settings', async () => {
  const h = handoffHarness(); h.controls.modelThinking = 'high';
  h.setModel({ provider: 'claude-code', id: 'claude-opus-5-5', api: 'claude-code-stream-json' });
  h.setThinking('high');
  await h.start();
  assert.deepEqual(h.saved().worker, { provider: 'claude-code', id: 'claude-sonnet-5-5' });
  assert.equal(h.saved().workerThinking, 'xhigh');
  await h.finish();
  assert.equal(h.ctx.model.id, 'claude-opus-5-5'); assert.equal(h.pi.getThinkingLevel(), 'high');
  assert.deepEqual(h.models, ['claude-sonnet-5-5', 'claude-opus-5-5']);
});

test('default xhigh may clamp; no lower tier is rejected before any checkpoint', async () => {
  const h = handoffHarness(); h.controls.thinkingClamp = true; await h.start();
  assert.equal(h.saved().phase, 'working'); assert.equal(h.saved().workerThinking, 'high');
  const bottom = handoffHarness();
  bottom.setModel({ provider: 'claude-code', id: 'claude-haiku-5-5', api: 'claude-code-stream-json' });
  await bottom.start();
  assert.equal(bottom.saved(), undefined); assert.equal(bottom.gitCalls.length, 0);
  assert.match(bottom.notices.at(-1), /No lower-tier claude-code model.*--model/);
  const same = handoffHarness(); same.setModel({ provider: 'anthropic', id: 'claude-opus', api: 'anthropic-messages' });
  same.setThinking('high'); await same.start('--model anthropic/claude-opus -- inspect only');
  assert.equal(same.saved().workerThinking, 'high'); assert.deepEqual(same.models, []); assert.deepEqual(same.thinkingChanges, []);
});

test('cross-provider handoff defaults to xhigh and restores original review', async () => {
  const h = handoffHarness(); h.controls.modelThinking = 'high';
  await h.start('--model claude-code/claude-opus -- inspect only');
  assert.equal(h.saved().worker.provider, 'claude-code'); assert.equal(h.saved().workerThinking, 'xhigh');
  assert.deepEqual(h.thinkingChanges, ['xhigh']);
  await h.reload(); assert.equal(h.sent.length, 1);
  assert.equal(h.saved().worker.provider, 'claude-code');
  await h.finish();
  assert.equal(h.ctx.model.provider, 'openai-codex'); assert.equal(h.ctx.model.id, 'gpt-6-astra');
  assert.equal(h.pi.getThinkingLevel(), 'medium'); assert.equal(h.saved().phase, 'returned');
});

test('same-model Claude effort change is rejected; a model switch may choose effort', async () => {
  const h = handoffHarness();
  h.setModel({ provider: 'claude-code', id: 'claude-opus', api: 'claude-code-stream-json' });
  h.setThinking('high');
  await h.start('--model claude-code/claude-opus --thinking low -- inspect only');
  assert.equal(h.saved(), undefined); assert.equal(h.sent.length, 0); assert.equal(h.gitCalls.length, 0);
  assert.equal(h.pi.getThinkingLevel(), 'high');
  await h.start('--model claude-code/claude-opus --thinking high -- inspect only');
  assert.equal(h.saved().phase, 'working'); assert.deepEqual(h.thinkingChanges, []);
  const cross = handoffHarness(); cross.controls.modelThinking = 'high';
  await cross.start('--model claude-code/claude-opus --thinking low -- inspect only');
  assert.equal(cross.saved().phase, 'working'); assert.equal(cross.pi.getThinkingLevel(), 'low');
});

test('malformed options and unavailable exact models are rejected before checkpoints', async () => {
  for (const args of ['', '--unknown x -- inspect', '--model', '--model -- inspect', '--model bare -- inspect',
    '--model /id -- inspect', '--model provider/ -- inspect', '--thinking extreme -- inspect',
    '--thinking low --thinking high -- inspect', '--model a/b --model c/d -- inspect',
    '--thinking high inspect', '--model a/b --']) {
    const h = handoffHarness(); await h.start(args);
    assert.equal(h.saved(), undefined, args); assert.equal(h.gitCalls.length, 0, args); assert.equal(h.sent.length, 0, args);
  }
  const missing = handoffHarness(); missing.controls.missingModel = true;
  await missing.start('--model absent/model -- inspect');
  assert.equal(missing.saved(), undefined); assert.equal(missing.gitCalls.length, 0);
  const tab = handoffHarness(); await tab.start('--thinking high --\tinspect');
  assert.equal(tab.saved().assignment, 'inspect');
});

test('handback uses the user-selected active worker, not the initial worker', async () => {
  const h = handoffHarness(); await h.start(explicitWorker);
  h.setModel({ provider: 'claude-code', id: 'claude-sonnet', api: 'claude-code-stream-json' });
  h.setThinking('high');
  await h.emit('model_select', { model: h.ctx.model });
  await h.emit('thinking_level_select', { level: 'high' });
  const packing = h.command('handback');
  assert.deepEqual(h.saved().worker, { provider: 'claude-code', id: 'claude-sonnet' });
  assert.equal(h.saved().workerThinking, 'high');
  h.answer(); await h.emit('agent_settled'); await packing;
  assert.equal(h.saved().phase, 'returned'); assert.equal(h.ctx.model.id, 'gpt-6-astra');
  assert.equal(h.pi.getThinkingLevel(), 'medium');
  assert.match(h.summaries[0], /claude-sonnet/);
});

test('legacy unfinished version-1 records recover using current worker without forced Luna', async () => {
  const h = handoffHarness(); await h.start();
  const legacy = structuredClone(h.saved()); delete legacy.worker; delete legacy.workerThinking;
  h.sm.appendCustomEntry('pi-handoff', legacy);
  await h.emit('session_shutdown');
  // Simulate the last record persisted by the legacy implementation.
  h.sm.appendCustomEntry('pi-handoff', legacy);
  h.setModel({ provider: 'claude-code', id: 'claude-sonnet', api: 'claude-code-stream-json' });
  h.setThinking('high');
  await h.emit('session_start');
  assert.equal(h.sent.length, 1); assert.equal(h.ctx.model.provider, 'claude-code');
  await h.finish();
  assert.equal(h.saved().phase, 'returned'); assert.equal(h.ctx.model.id, 'gpt-6-astra');
  assert.equal(h.pi.getThinkingLevel(), 'medium'); assert.equal(h.saved().worker.id, 'claude-sonnet');
  await h.reload(); await h.command('handback'); assert.equal(h.sent.length, 3);
});

test('completed legacy version-1 records do not resurrect a handoff', async () => {
  const h = handoffHarness(); await h.start(); await h.finish();
  const legacy = structuredClone(h.saved()); delete legacy.worker; delete legacy.workerThinking;
  h.sm.appendCustomEntry('pi-handoff', legacy);
  await h.reload(); await h.command('handback');
  assert.equal(h.sent.length, 3); assert.deepEqual(h.models, ['gpt-6.1-sol', 'gpt-6-astra']);
});

test('reload while packing cancels old command; explicit handback remains possible', async () => {
  const h = handoffHarness(); await h.start(); const task = h.command('handback');
  await h.reload(); await task; assert.equal(h.sent.length, 2);
  await h.finish(); assert.equal(h.saved().phase, 'returned');
});
