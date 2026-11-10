import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { piDependency } from './helpers/pi-package.mjs';
import { planWarmCompaction, checkpointText, checkpointRequest, describeBoundary, REQUEST_MARKER } from '../extensions/lib/warm-compact.ts';

const big = n => 'x'.repeat(n * 4); // n tokens at chars/4
const msg = (role, text, extra = {}) => ({ role, content: [{ type: 'text', text }], ...extra });
const entry = (id, ...messages) => ({ sourceEntry: { id, type: 'message' }, messages });

test('plan keeps ~keepRecent tokens and never cuts at a tool result', () => {
  const projected = [
    entry('u1', msg('user', 'first task')),
    entry('a1', { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a' } }] }),
    entry('r1', msg('toolResult', big(30_000))),
    entry('u2', msg('user', 'second task, please')),
    entry('a2', { role: 'assistant', content: [{ type: 'toolCall', id: 't2', name: 'read', arguments: { path: 'b' } }] }),
    entry('r2', msg('toolResult', big(15_000))),
    entry('a3', msg('assistant', 'done with b')),
  ];
  const p = planWarmCompaction(projected, 10_000);
  assert.equal(p.firstKeptEntryId, 'a3', 'cut moves forward past the tool result to the next assistant message');
  const p2 = planWarmCompaction(projected, 20_000);
  assert.equal(p2.firstKeptEntryId, 'u2', 'cuts at the next user message, never at a tool result');
  assert.ok(p2.summarizedTokens > 30_000 && p2.keptTokens >= 15_000);
  assert.equal(planWarmCompaction(projected.slice(-1), 20_000), undefined, 'nothing to do when it all fits');
  assert.match(checkpointRequest(p2), /Do not call any tools/);
  assert.match(p2.boundaryHint, /user message that begins "second task, please"/);
  assert.match(p.boundaryHint, /message 1 counting back from the end/);
  assert.match(checkpointRequest(p2, 'the backup work'), /Additional focus: the backup work/);
});

test('boundary: a reply with no text is described by its tool call, never as ""', () => {
  const call = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'toolCall', id: 't', name: 'bash', arguments: { command: 'git status' } }] }];
  const d = describeBoundary(call, 7);
  assert.ok(d.includes('assistant message that calls the bash tool ({"command":"git status"})'), d);
  assert.match(d, /message 7 counting back/);
  assert.doesNotMatch(d, /""/);
  assert.match(describeBoundary([{ role: 'custom', content: 'hello there' }], 3), /user message that begins "hello there"/);
});

test('checkpoint replies: format, tool calls and truncation are rejected', () => {
  const ok = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '## Goal\nx\n## Next Steps\n1. y' }] };
  assert.ok(checkpointText(ok).text);
  assert.match(checkpointText({ ...ok, stopReason: 'length' }).error, /output limit/);
  assert.match(checkpointText({ ...ok, content: [...ok.content, { type: 'toolCall', id: 'x', name: 'bash', arguments: {} }] }).error, /called a tool/);
  assert.match(checkpointText({ ...ok, content: [{ type: 'text', text: 'sure!' }] }).error, /checkpoint format/);
});

// Native Pi session with scripted replies: no auth, network or real provider.
const root = process.env.PI_PACKAGE_ROOT;
const native = file => import(pathToFileURL(resolve(root, file)).href);

test('native: the checkpoint request extends the cached prefix; afterwards the context is summary + tail', { skip: !root }, async () => {
  const [{ createAgentSession }, { SettingsManager }, { SessionManager }, { createExtensionRuntime, loadExtensions },
    { AssistantMessageEventStream }] = await Promise.all([
    native('dist/core/sdk.js'), native('dist/core/settings-manager.js'), native('dist/core/session-manager.js'),
    native('dist/core/extensions/loader.js'),
    import(pathToFileURL(piDependency(root, '@earendil-works/pi-ai', 'dist/utils/event-stream.js')).href)]);

  const model = { id: 'claude-opus-5-5', name: 'Opus', api: 'claude-code-stream-json', provider: 'claude-code', reasoning: true,
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 8000 };
  const usage = (cacheRead = 0) => ({ input: 5, output: 50, cacheRead, cacheWrite: 0, totalTokens: 55 + cacheRead,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const base = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop' };
  const reply = text => ({ ...base, content: [{ type: 'text', text }], usage: usage() });
  const CHECKPOINT = '## Goal\nShip the thing.\n\n## Progress\n### Done\n- [x] step one\n\n## Next Steps\n1. step two\n\n## Critical Context\n- path: src/a.ts';
  const replies = [reply('First answer. ' + big(15_000)), reply('Second answer. ' + big(25_000)), reply('Third answer, short.'),
    { ...reply(CHECKPOINT), usage: usage(40_000) }, reply('After compaction.')];
  const requests = [];
  const runtime = { getModel: () => model, getPhysicalModel: () => model, hasConfiguredAuth: () => true, isUsingOAuth: () => true,
    getAvailableSnapshot: () => [model],
    async streamSimple(_m, context) {
      requests.push(structuredClone({ systemPrompt: context.systemPrompt, tools: (context.tools ?? []).map(t => t.name), messages: context.messages }));
      const r = replies.shift();
      assert.ok(r, 'unexpected extra model request');
      const s = new AssistantMessageEventStream();
      s.push({ type: 'done', reason: 'stop', message: r });
      s.end();
      return s;
    } };

  const loaded = await loadExtensions([resolve('extensions/pi-warm-compact.ts')], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const resourceLoader = {
    getExtensions: () => loaded,
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
  const manager = SessionManager.inMemory(process.cwd());
  const { session } = await createAgentSession({ cwd: process.cwd(), model, thinkingLevel: 'medium', modelRuntime: runtime,
    sessionManager: manager, resourceLoader, tools: ['read'],
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' }) });
  const notes = [];
  await session.bindExtensions?.({ uiContext: { notify: (m, t) => notes.push(`${t}:${m}`) } });

  await session.prompt('Task one.');
  await session.prompt('Task two.');
  await session.prompt('Task three.');
  await session.prompt('/warm-compact summary keep=20k');
  // pi.sendMessage starts the turn without awaiting it.
  for (let i = 0; i < 50 && requests.length < 4; i++) await new Promise(r => setTimeout(r, 10));
  await session.waitForIdle();
  assert.equal(requests.length, 4, `one checkpoint request (notes: ${notes.join(' | ')})`);

  // 1. Cache-warm: the checkpoint request is the previous request plus one new tail, byte for byte.
  const [prev, warm] = [requests[2], requests[3]];
  assert.equal(warm.systemPrompt, prev.systemPrompt, 'same system prompt');
  assert.deepEqual(warm.tools, prev.tools, 'tools still declared');
  const prevWithReply = prev.messages.length; // previous request + its reply + the new instruction
  assert.deepEqual(warm.messages.slice(0, prevWithReply), prev.messages, 'previous request is an exact prefix');
  assert.equal(warm.messages.length, prevWithReply + 2, 'adds only the previous reply and the instruction');
  const instr = warm.messages.at(-1);
  assert.match(JSON.stringify(instr.content), new RegExp(REQUEST_MARKER.replace(/[[\]]/g, '\\$&')));

  // 2. Session: a compaction entry with the checkpoint, and both hidden turns omitted.
  const branch = manager.getBranch();
  const comp = branch.findLast(e => e.type === 'compaction');
  assert.ok(comp, `compaction appended (notes: ${notes.join(' | ')})`);
  assert.equal(comp.summary, CHECKPOINT);
  assert.equal(comp.details.mode, 'warm');
  assert.ok(notes.some(n => /done in/.test(n) && /cache read 40,000/.test(n)), notes.join(' | '));
  const status = branch.filter(e => e.type === 'custom' && e.customType === 'pi-warm-compact-status').map(e => e.data);
  assert.deepEqual(status.map(s => s.phase), ['start', 'done'], 'status lines in the chat');
  assert.match(status[1].text, /Cache hit: cache read 40,000/);

  // 3. The next request: summary first, then the kept tail; no instruction, no checkpoint reply.
  await session.prompt('Continue.');
  const next = requests[4];
  const flat = JSON.stringify(next.messages);
  assert.ok(flat.includes('Ship the thing.'), 'summary is in context');
  assert.ok(!flat.includes(REQUEST_MARKER), 'the instruction is omitted');
  assert.equal((flat.match(/## Goal/g) || []).length, 1, 'the checkpoint appears once (as the summary), not also as a reply');
  assert.ok(!flat.includes('First answer.'), 'old turns are summarized away');
  assert.ok(flat.includes('Second answer.') && flat.includes('Third answer, short.'), 'the recent tail is kept verbatim');
  assert.ok(flat.includes('Continue.'));
});

test('native: a tool call instead of a checkpoint is blocked and leaves the context unchanged', { skip: !root }, async () => {
  const [{ createAgentSession }, { SettingsManager }, { SessionManager }, { loadExtensions }, { AssistantMessageEventStream }] = await Promise.all([
    native('dist/core/sdk.js'), native('dist/core/settings-manager.js'), native('dist/core/session-manager.js'),
    native('dist/core/extensions/loader.js'),
    import(pathToFileURL(piDependency(root, '@earendil-works/pi-ai', 'dist/utils/event-stream.js')).href)]);
  const model = { id: 'claude-opus-5-5', name: 'Opus', api: 'claude-code-stream-json', provider: 'claude-code', reasoning: true,
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 8000 };
  const usage = { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const base = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage };
  const replies = [
    { ...base, stopReason: 'stop', content: [{ type: 'text', text: 'Old answer. ' + big(30_000) }] },
    { ...base, stopReason: 'stop', content: [{ type: 'text', text: 'Recent answer. ' + big(25_000) }] },
    { ...base, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'tc1', name: 'probe', arguments: {} }] },
    { ...base, stopReason: 'stop', content: [{ type: 'text', text: 'Normal turn.' }] },
  ];
  const requests = []; let executed = 0;
  const runtime = { getModel: () => model, getPhysicalModel: () => model, hasConfiguredAuth: () => true, isUsingOAuth: () => true,
    getAvailableSnapshot: () => [model],
    async streamSimple(_m, context) {
      requests.push(structuredClone(context.messages));
      const r = replies.shift(); assert.ok(r, 'unexpected extra model request');
      const s = new AssistantMessageEventStream(); s.push({ type: 'done', reason: r.stopReason, message: r }); s.end(); return s;
    } };
  const loaded = await loadExtensions([resolve('extensions/pi-warm-compact.ts')], process.cwd());
  const resourceLoader = { getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {} };
  const probe = { name: 'probe', label: 'probe', description: 'test tool', parameters: { type: 'object', properties: {} },
    execute: async () => { executed++; return { content: [{ type: 'text', text: 'ran' }], details: undefined }; } };
  const manager = SessionManager.inMemory(process.cwd());
  const { session } = await createAgentSession({ cwd: process.cwd(), model, thinkingLevel: 'medium', modelRuntime: runtime,
    sessionManager: manager, resourceLoader, tools: ['probe'], customTools: [probe],
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' }) });
  const notes = [];
  await session.bindExtensions?.({ uiContext: { notify: (m, t) => notes.push(`${t}:${m}`) } });
  await session.prompt('One.');
  await session.prompt('Two.');
  await session.prompt('/warm-compact summary keep=20k');
  for (let i = 0; i < 50 && requests.length < 3; i++) await new Promise(r => setTimeout(r, 10));
  await session.waitForIdle();
  assert.equal(executed, 0, 'the tool never ran');
  assert.equal(manager.getBranch().filter(e => e.type === 'compaction').length, 0, 'no compaction written');
  assert.ok(notes.some(n => /failed \(the model called a tool/.test(n)), notes.join(' | '));
  await session.prompt('Three.');
  const flat = JSON.stringify(requests.at(-1));
  assert.ok(!flat.includes(REQUEST_MARKER) && !flat.includes('tc1'), 'the failed attempt is omitted from context');
  assert.ok(flat.includes('Old answer.') && flat.includes('Recent answer.') && flat.includes('Three.'), 'the rest is unchanged');
});
