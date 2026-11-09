import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { handoffHarness } from './helpers/handoff-harness.mjs';
import { piDependency } from './helpers/pi-package.mjs';

const root = process.env.PI_PACKAGE_ROOT;
const native = path => import(pathToFileURL(resolve(root, path)).href);

test('handoff/handback with native in-memory SessionManager: restored context and off-branch retrieval', { skip: !root }, async () => {
  const { SessionManager } = await native('dist/core/session-manager.js');
  const sm = SessionManager.inMemory(process.cwd());
  sm.getSessionFile = () => '/test/in-memory-only.jsonl'; // Locator only; manager still never writes to disk.
  sm.appendMessage({ role: 'user', content: 'Astra planning context', timestamp: 1 });
  const h = handoffHarness({ sm });
  await h.start();
  const evidence = sm.appendMessage({ role: 'toolResult', toolName: 'read', toolCallId: 'test', isError: false,
    content: [{ type: 'text', text: 'specific original evidence not in the summary' }], timestamp: 2 });
  const original = await h.finish();
  assert.equal(h.saved().phase, 'returned');
  const context = sm.buildSessionContext();
  const summary = context.messages.find(m => m.role === 'branchSummary');
  assert.ok(summary.summary.endsWith(original.text));
  assert.ok(!context.messages.some(m => m.role === 'toolResult'));
  assert.equal(h.ctx.model.provider, h.saved().origin.provider);
  assert.equal(h.ctx.model.id, h.saved().origin.id);
  assert.equal(h.pi.getThinkingLevel(), h.saved().thinking);
  const leaf = sm.getLeafId();
  const result = await h.tools.get('handoff_history').execute('test', {
    runId: h.saved().runId, entryId: evidence,
  }, undefined, undefined, h.ctx);
  assert.match(result.content[0].text, /specific original evidence/);
  assert.equal(sm.getLeafId(), leaf);
  // Model API/event dispatch is a fake facade here; SessionManager storage and context
  // reconstruction are native. Full UI lifecycle still needs interactive acceptance.
});

test('cross-provider handback restores original model and retains native worker evidence', { skip: !root }, async () => {
  const { SessionManager } = await native('dist/core/session-manager.js');
  const sm = SessionManager.inMemory(process.cwd());
  sm.getSessionFile = () => '/test/cross-provider-only.jsonl';
  sm.appendMessage({ role: 'user', content: 'Claude planning context', timestamp: 1 });
  const h = handoffHarness({ sm });
  h.setModel({ provider: 'claude-code', id: 'claude-opus', api: 'claude-code-stream-json' });
  h.setThinking('high');
  await h.start('--model openai-codex/gpt-6-luna --thinking xhigh -- bounded OpenAI pass');
  assert.equal(h.saved().worker.id, 'gpt-6-luna');
  assert.equal(h.saved().workerThinking, 'xhigh');
  const source = sm.appendMessage({ role: 'toolResult', toolName: 'read', toolCallId: 'test', isError: false,
    content: [{ type: 'text', text: 'cross-provider source evidence' }], timestamp: 2 });
  await h.reload(); assert.equal(h.sent.length, 1);
  const original = await h.finish();
  assert.equal(h.ctx.model.provider, 'claude-code'); assert.equal(h.ctx.model.id, 'claude-opus');
  assert.equal(h.pi.getThinkingLevel(), 'high');
  const context = sm.buildSessionContext();
  assert.ok(context.messages.find(m => m.role === 'branchSummary').summary.endsWith(original.text));
  const result = await h.tools.get('handoff_history').execute('test', {
    runId: h.saved().runId, entryId: source,
  }, undefined, undefined, h.ctx);
  assert.match(result.content[0].text, /cross-provider source evidence/);
});

test('installed Pi argument validator accepts plain tool schema and rejects invalid bounds', { skip: !root }, async () => {
  const { validateToolArguments } = await native(piDependency(root, '@earendil-works/pi-ai', 'dist/utils/validation.js'));
  const h = handoffHarness(), tool = h.tools.get('handoff_history');
  const call = args => validateToolArguments(tool, { id: 'test', name: tool.name, arguments: args });
  assert.deepEqual(call({ runId: 'test', query: 'needle', limit: 2 }), { runId: 'test', query: 'needle', limit: 2 });
  assert.throws(() => call({ runId: 'test', offset: -1 }));
  assert.throws(() => call({ runId: 'test', limit: 100 }));
});
