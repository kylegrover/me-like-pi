import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { piDependency } from './helpers/pi-package.mjs';
import { ruleContent, ruleEdits, buildMap, parsePlan, applyPlan, sizes } from '../extensions/lib/edit-compact.ts';

const P = (id, m) => ({ sourceEntry: { id, type: 'message' }, messages: [m] });
const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });

test('edit rules: long tool output and arguments shrink to a recallable placeholder; thinking goes', () => {
  const r = ruleContent('e1', { role: 'toolResult', toolCallId: 't', content: [{ type: 'text', text: 'A'.repeat(5000) }] });
  assert.equal(r.length, 1);
  assert.ok(r[0].text.startsWith('A'.repeat(300)));
  assert.match(r[0].text, /4,700 more chars of tool output elided; context_recall\("e1"\)/);
  assert.equal(ruleContent('e2', { role: 'toolResult', content: [{ type: 'text', text: 'short' }] }), undefined, 'short output stays');
  const a = ruleContent('e3', { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'ok' },
    call('t1', 'write', { path: 'a.ts', content: 'x'.repeat(2000) })] });
  assert.deepEqual(a.map(b => b.type), ['text', 'toolCall'], 'thinking dropped, call kept');
  assert.equal(a[1].id, 't1', 'call id kept, so its result still pairs');
  assert.match(a[1].arguments._elided, /context_recall\("e3"\)/);
});

const convo = () => [
  P('u1', { role: 'user', content: 'Investigate the crash in parser.ts' }),
  P('a1', { role: 'assistant', content: [{ type: 'text', text: 'Looking. ' + 'detail '.repeat(300) }, call('t1', 'read', { path: 'parser.ts' })] }),
  P('r1', { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'code '.repeat(2000) }] }),
  P('a2', { role: 'assistant', content: [{ type: 'text', text: 'Found it: off-by-one at line 42. ' + 'reasoning '.repeat(400) }] }),
  P('u2', { role: 'user', content: 'Side question: what does the lexer do?' }),
  P('a3', { role: 'assistant', content: [{ type: 'text', text: 'The lexer ' + 'explains '.repeat(500) }] }),
  P('u3', { role: 'user', content: 'ok, fix the crash' }),
  P('a4', { role: 'assistant', content: [{ type: 'text', text: 'Fixed in commit abc123.' }] }),
];

test('edit plan: condense, fold whole turns, regex replace; pairs stay intact; sizes shrink', () => {
  const projected = convo();
  const cut = 6; // keep u3, a4
  const rules = ruleEdits(projected, 0, cut);
  assert.deepEqual([...rules.keys()].sort(), ['r1']);
  const items = buildMap(projected, 0, cut);
  assert.deepEqual(items.map(i => `${i.n}${i.role[0]}`), ['1u', '2a', '3a', '4u', '5a']);
  const { ops, error } = parsePlan('```json\n{"edits":[{"op":"condense","n":3,"text":"Crash cause: off-by-one at parser.ts:42."},' +
    '{"op":"fold","from":4,"to":5,"note":"lexer side question answered"},{"op":"replace","n":2,"find":"detail ","with":""},{"op":"condense","n":99,"text":"x"}]}\n```');
  assert.equal(error, undefined);
  const { edits, skipped } = applyPlan(projected, 0, cut, items, ops, rules);
  assert.deepEqual(skipped, ['condense #99: unknown message']);
  assert.equal(edits.get('a2').replacement.content[0].text, 'Crash cause: off-by-one at parser.ts:42.');
  assert.equal(edits.get('u2'), undefined, 'the side question itself stays');
  assert.equal(edits.get('a3').replacement.content[0].text, '[folded: lexer side question answered]');
  const a1 = edits.get('a1').replacement.content;
  assert.equal(a1[0].text, 'Looking. ', 'regex applied');
  assert.equal(a1[1].id, 't1', 'its tool call (and so its result) kept');
  assert.ok(edits.get('r1').replacement, 'result still present (shortened), paired with t1');
  const s = sizes(projected, 0, cut, edits);
  assert.ok(s.after < s.before / 4, `older context shrank: ${s.before} -> ${s.after}`);
});

test('edit plan: folding a turn with tool calls removes calls and results together', () => {
  const projected = convo();
  const items = buildMap(projected, 0, 6);
  const { edits } = applyPlan(projected, 0, 6, items, [{ op: 'fold', from: 1, to: 2, note: 'crash found at parser.ts:42' }], ruleEdits(projected, 0, 6));
  assert.equal(edits.get('u1'), undefined, 'the request stays');
  assert.equal(edits.get('a1').replacement, null, 'the folded step (with its call) is hidden');
  assert.equal(edits.get('r1').replacement, null, 'its result gone too');
  // #2 is a1; the next mapped message (a2) is not in the fold, so the note moves onto it.
  const a2 = edits.get('a2').replacement.content;
  assert.equal(a2[0].text, '[folded: crash found at parser.ts:42]');
  assert.match(a2[1].text, /^Found it: off-by-one/, 'the reply after the fold stays');
  const all = applyPlan(projected, 0, 6, items, [{ op: 'fold', from: 1, to: 3, note: 'crash found' }], ruleEdits(projected, 0, 6)).edits;
  assert.equal(all.get('a1').replacement.content[0].text, '[folded: crash found]', 'a fold to the end of the turn keeps one note');
  assert.equal(all.get('a2').replacement, null);
  assert.ok(!all.get('a1').replacement.content.some(b => b.type === 'toolCall'), 'call gone');
  assert.match(parsePlan('nope').error, /not JSON/);
});

// Native Pi session with scripted replies: no auth, network or real provider.
const root = process.env.PI_PACKAGE_ROOT;
const native = file => import(pathToFileURL(resolve(root, file)).href);

test('native: /warm-compact edit applies rule + model edits; context_recall restores an original', { skip: !root }, async () => {
  const [{ createAgentSession }, { SettingsManager }, { SessionManager }, { loadExtensions }, { AssistantMessageEventStream }] = await Promise.all([
    native('dist/core/sdk.js'), native('dist/core/settings-manager.js'), native('dist/core/session-manager.js'),
    native('dist/core/extensions/loader.js'),
    import(pathToFileURL(piDependency(root, '@earendil-works/pi-ai', 'dist/utils/event-stream.js')).href)]);
  const model = { id: 'claude-opus-5-5', name: 'Opus', api: 'claude-code-stream-json', provider: 'claude-code', reasoning: true,
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 8000 };
  const usage = (cacheRead = 0) => ({ input: 5, output: 5, cacheRead, cacheWrite: 10, totalTokens: 20 + cacheRead,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const base = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: usage() };
  const BIG = 'L'.repeat(60_000);
  const replies = [
    { ...base, stopReason: 'toolUse', content: [{ type: 'text', text: 'Reading the log.' }, { type: 'toolCall', id: 'tc1', name: 'probe', arguments: {} }] },
    { ...base, stopReason: 'stop', content: [{ type: 'text', text: 'Log read.' }] },
    { ...base, stopReason: 'stop', content: [{ type: 'text', text: 'Old analysis. ' + 'words '.repeat(6000) }] },
    { ...base, stopReason: 'stop', content: [{ type: 'text', text: 'Recent answer. ' + 'r'.repeat(90_000) }] },
    { ...base, usage: usage(50_000), stopReason: 'stop', content: [{ type: 'text', text: 'PLAN' }] },
    { ...base, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'tc2', name: 'context_recall', arguments: { id: 'PLACEHOLDER' } }] },
    { ...base, stopReason: 'stop', content: [{ type: 'text', text: 'Recalled.' }] },
  ];
  const requests = [];
  const runtime = { getModel: () => model, getPhysicalModel: () => model, hasConfiguredAuth: () => true, isUsingOAuth: () => true,
    getAvailableSnapshot: () => [model],
    async streamSimple(_m, context) {
      requests.push(structuredClone(context.messages));
      const r = replies.shift(); assert.ok(r, 'unexpected extra model request');
      // The plan's message numbers come from the map in the request just sent.
      if (r.content[0]?.text === 'PLAN') {
        const req = JSON.stringify(context.messages.at(-1));
        const n = /#(\d+) assistant ~\d+ tok: \\"Old analysis/.exec(req)?.[1];
        assert.ok(n, 'map lists the old analysis');
        r.content[0].text = '```json\n{"edits":[{"op":"condense","n":' + n + ',"text":"Old analysis, condensed: root cause X."}]}\n```';
      }
      const s = new AssistantMessageEventStream(); s.push({ type: 'done', reason: r.stopReason, message: r }); s.end(); return s;
    } };
  const loaded = await loadExtensions([resolve('extensions/pi-warm-compact.ts')], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const resourceLoader = { getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {} };
  const probe = { name: 'probe', label: 'probe', description: 'test tool', parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: BIG }], details: undefined }) };
  const manager = SessionManager.inMemory(process.cwd());
  const { session } = await createAgentSession({ cwd: process.cwd(), model, thinkingLevel: 'medium', modelRuntime: runtime,
    sessionManager: manager, resourceLoader, tools: ['probe', 'context_recall'], customTools: [probe],
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' }) });
  const notes = [];
  await session.bindExtensions?.({ uiContext: { notify: (m, t) => notes.push(`${t}:${m}`) } });
  await session.prompt('Look at the log.');
  await session.prompt('Analyse it.');
  await session.prompt('Now the recent part.');
  await session.prompt('/warm-compact edit keep=20k');
  for (let i = 0; i < 50 && requests.length < 5; i++) await new Promise(r => setTimeout(r, 10));
  await session.waitForIdle();
  const status = manager.getBranch().filter(e => e.type === 'custom' && e.customType === 'pi-warm-compact-status').map(e => e.data);
  assert.deepEqual(status.map(s => s.phase), ['start', 'done'], `${notes.join(' | ')} ${JSON.stringify(status)}`);
  assert.match(status[1].text, /edit mode done.*Cache hit/);
  assert.equal(manager.getBranch().filter(e => e.type === 'compaction').length, 0, 'edit mode writes no summary');
  const resultEntry = manager.getBranch().find(e => e.type === 'message' && e.message.role === 'toolResult');
  replies[0].content[0].arguments.id = resultEntry.id;
  await session.prompt('Recall the log.');
  const flat = JSON.stringify(requests.at(-2));
  assert.ok(flat.includes('Old analysis, condensed: root cause X.'), 'model edit applied');
  assert.ok(!flat.includes('words words words words'), 'old long text gone');
  assert.ok(flat.includes(`context_recall(\\"${resultEntry.id}\\")`), 'placeholder names the entry');
  assert.ok(!flat.includes(BIG), 'big tool output elided');
  assert.ok(flat.includes('Recent answer.'), 'recent tail verbatim');
  assert.ok(!flat.includes('[pi-warm-compact request]'), 'instruction hidden');
  assert.ok(JSON.stringify(requests.at(-1)).includes('L'.repeat(1000)), 'context_recall returned the original output');
});

test('fold keeps every user message; later assistant runs get a pointer; skipped ops have reasons', () => {
  const projected = [
    P('u1', { role: 'user', content: 'Investigate the crash' }),
    P('a1', { role: 'assistant', content: [{ type: 'text', text: 'Looking. ' + 'x '.repeat(300) }] }),
    P('u2', { role: 'user', content: 'what are those python processes?' }),
    P('a2', { role: 'assistant', content: [{ type: 'text', text: 'It is the D12 queue. ' + 'y '.repeat(300) }] }),
    P('u3', { role: 'user', content: 'stop it after this one' }),
    P('a3', { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }),
  ];
  const items = buildMap(projected, 0, 6);
  const { ops, invalid } = parsePlan('{"edits":[{"op":"fold","from":1,"to":6,"note":"crash + D12 queue stopped"},{"op":"bogus"},{"op":"fold","from":5,"to":3,"note":"x"}]}');
  assert.deepEqual(invalid.map(s => s.slice(0, 30)), ['malformed op: {"op":"bogus"}', 'malformed op: {"op":"fold","fr'],
    'unknown op and reversed fold both reported with their text');
  const { edits, skipped } = applyPlan(projected, 0, 6, items, ops, new Map());
  for (const id of ['u1', 'u2', 'u3']) assert.equal(edits.get(id), undefined, `${id} stays verbatim`);
  assert.equal(edits.get('a1').replacement.content[0].text, '[folded: crash + D12 queue stopped]');
  assert.equal(edits.get('a2').replacement.content[0].text, '[folded into the note above]', 'roles still alternate');
  assert.equal(edits.get('a3').replacement.content[0].text, '[folded into the note above]');
  assert.deepEqual(skipped, []);
  const unknown = applyPlan(projected, 0, 6, items, [{ op: 'condense', n: 42, text: 'x' }], new Map());
  assert.deepEqual(unknown.skipped, ['condense #42: unknown message']);
});

test('edit request states a size target (~40% of the mapped text)', async () => {
  const { editRequest } = await import('../extensions/lib/edit-compact.ts');
  const items = [{ n: 1, index: 0, entryId: 'a', role: 'assistant', tokens: 20_000, opening: 'x' }];
  const r = editRequest('the user message', items, 1000);
  assert.match(r, /about 20k tokens\. Leave at least ~8k of it/);
  assert.match(r, /User messages in the range always stay/);
});

test('fold of a short step does not swallow the condensed reply after it (run-2 bug)', () => {
  const projected = [
    P('u1', { role: 'user', content: 'Run the trial' }),
    P('a1', { role: 'assistant', content: [{ type: 'text', text: 'Setting up the trial folder.' }, call('t1', 'bash', { command: 'mkdir trial' })] }),
    P('r1', { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'ok' }] }),
    P('a2', { role: 'assistant', content: [call('t2', 'bash', { command: 'pi --run' })] }),
    P('r2', { role: 'toolResult', toolCallId: 't2', content: [{ type: 'text', text: 'log '.repeat(500) }] }),
    P('a3', { role: 'assistant', content: [{ type: 'text', text: 'The trial passed every criterion. ' + 'detail '.repeat(300) }] }),
    P('u2', { role: 'user', content: 'great' }),
    P('a4', { role: 'assistant', content: [{ type: 'text', text: 'Next step.' }] }),
  ];
  const items = buildMap(projected, 0, 6);
  assert.deepEqual(items.map(i => i.entryId), ['u1', 'a1', 'a3']);
  const ops = [{ op: 'fold', from: 2, to: 2, note: 'set up trial folder, ran pi' }, { op: 'condense', n: 3, text: 'Trial passed all criteria.' }];
  const { edits, skipped } = applyPlan(projected, 0, 6, items, ops, ruleEdits(projected, 0, 6));
  assert.deepEqual(skipped, [], 'the condense is no longer "inside a fold"');
  assert.equal(edits.get('a1').replacement, null, 'the folded step is hidden');
  assert.equal(edits.get('a2').replacement, null, 'its unmapped tool-only step too');
  assert.equal(edits.get('r1').replacement, null);
  assert.equal(edits.get('r2').replacement, null, 'results leave with their calls');
  const a3 = edits.get('a3').replacement.content;
  assert.deepEqual(a3.map(b => b.text), ['[folded: set up trial folder, ran pi]', 'Trial passed all criteria.'],
    'note moved onto the next assistant message, then the condensed text');
  assert.equal(edits.get('u1'), undefined);
});

test('two adjacent folds in one turn merge their notes', () => {
  const projected = [
    P('u1', { role: 'user', content: 'go' }),
    P('a1', { role: 'assistant', content: [{ type: 'text', text: 'step one' }, call('t1', 'bash', { command: 'a' })] }),
    P('r1', { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'ok' }] }),
    P('a2', { role: 'assistant', content: [{ type: 'text', text: 'step two' }, call('t2', 'bash', { command: 'b' })] }),
    P('r2', { role: 'toolResult', toolCallId: 't2', content: [{ type: 'text', text: 'ok' }] }),
    P('a3', { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] }),
  ];
  const items = buildMap(projected, 0, 6);
  const ops = [{ op: 'fold', from: 2, to: 2, note: 'one' }, { op: 'fold', from: 3, to: 3, note: 'two' }];
  const { edits } = applyPlan(projected, 0, 6, items, ops, new Map());
  assert.equal(edits.get('a1').replacement, null);
  assert.equal(edits.get('a2').replacement, null);
  assert.equal(edits.get('a3').replacement.content[0].text, '[folded: one]\n[folded: two]');
  assert.equal(edits.get('a3').replacement.content[1].text, 'final answer');
});

test('second pass: earlier placeholders are not re-stubbed, compacted messages are marked, size target counts only new text', async () => {
  const { editRequest, mapText } = await import('../extensions/lib/edit-compact.ts');
  // An entry whose projected content was already replaced by a first pass (raw differs from projected).
  const stub = 'out '.repeat(80) + '\n[… 9,000 more chars of tool output elided; context_recall("r1") restores the original]';
  const projected = [
    { sourceEntry: { id: 'u1', type: 'message', message: { role: 'user', content: 'Run it' } }, messages: [{ role: 'user', content: 'Run it' }] },
    { sourceEntry: { id: 'a1', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'long '.repeat(900) }, call('t1', 'bash', { command: 'x' })] } },
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Ran it; 3 failures fixed (condensed).' }, call('t1', 'bash', { command: 'x' })] }] },
    { sourceEntry: { id: 'r1', type: 'message', message: { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'out '.repeat(3000) }] } },
      messages: [{ role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: stub }] }] },
    { sourceEntry: { id: 'a2', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'old' }] } },
      messages: [{ role: 'assistant', content: [{ type: 'text', text: '[folded into the note above]' }] }] },
    { sourceEntry: { id: 'u2', type: 'message', message: { role: 'user', content: 'Now the docs' } }, messages: [{ role: 'user', content: 'Now the docs' }] },
    { sourceEntry: { id: 'a3', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Docs written. ' + 'new '.repeat(4000) }] } },
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Docs written. ' + 'new '.repeat(4000) }] }] },
  ];
  const rules = ruleEdits(projected, 0, 6);
  assert.equal(rules.get('r1'), undefined, 'an earlier placeholder is left alone (its recall handle stays exact)');
  const items = buildMap(projected, 0, 6);
  assert.deepEqual(items.map(i => i.entryId), ['u1', 'a1', 'u2', 'a3'], 'fold filler is not mapped');
  assert.deepEqual(items.map(i => !!i.compacted), [false, true, false, false]);
  assert.match(mapText(items), /#2 assistant \(compacted\)/);
  const r = editRequest('the user message', items, 0);
  assert.match(r, /not yet compacted is about 4k tokens/, 'target from new text only');
  assert.match(r, /1 messages are marked \(compacted\)/);
});

test('options: keep, target (percent or auto), budget (tokens or off), then focus; bad values are reported', async () => {
  const { parseWarmArgs, DEFAULT_KEEP, DEFAULT_BUDGET } = await import('../extensions/lib/warm-compact.ts');
  const d = parseWarmArgs('');
  assert.deepEqual([d.mode, d.keep, d.budget, d.target, d.focus, d.errors], ['edit', DEFAULT_KEEP, DEFAULT_BUDGET, undefined, undefined, []]);
  const o = parseWarmArgs('summary keep=50k target=55% budget=off keep the G1 numbers');
  assert.deepEqual([o.mode, o.keep, o.target, o.budget, o.focus], ['summary', 50_000, 0.55, 0, 'keep the G1 numbers']);
  assert.equal(parseWarmArgs('target=auto').target, 'auto');
  assert.equal(parseWarmArgs('budget=60k').budget, 60_000);
  assert.equal(parseWarmArgs('the keep=10k part is focus').focus, 'the keep=10k part is focus', 'options only at the start');
  assert.deepEqual(parseWarmArgs('keep=1k target=200 budget=2k').errors.length, 3);
});

test('estimate: thinking is not counted; real scale leaves out the fixed overhead', async () => {
  const { estimateMessageTokens, realScale, PER_MESSAGE, CONTEXT_OVERHEAD } = await import('../extensions/lib/warm-compact.ts');
  const m = { role: 'assistant', content: [{ type: 'thinking', thinking: 'x'.repeat(4000) }, { type: 'text', text: 'y'.repeat(400) }] };
  assert.equal(estimateMessageTokens(m), 100 + PER_MESSAGE);
  assert.equal(realScale(CONTEXT_OVERHEAD + 200_000, 100_000), 2);
  assert.equal(realScale(undefined, 100), 1);
});

// A long session after earlier passes: an old summary on top, compacted turns, then new turns.
const rolling = () => {
  const raw = (id, role, text) => ({ id, type: 'message', message: { role, content: role === 'user' ? text : [{ type: 'text', text }] } });
  const compacted = (id, text, shown) => ({ sourceEntry: raw(id, 'assistant', text), messages: [{ role: 'assistant', content: [{ type: 'text', text: shown }] }] });
  const plain = (id, role, text) => ({ sourceEntry: raw(id, role, text), messages: [{ role, content: role === 'user' ? text : [{ type: 'text', text }] }] });
  const out = [{ sourceEntry: { id: 'c0', type: 'compaction', summary: 'S'.repeat(20_000) }, messages: [{ role: 'compactionSummary', summary: 'S'.repeat(20_000), content: '' }] }];
  for (let i = 1; i <= 12; i++) {
    out.push(plain(`u${i}`, 'user', `old request ${i}`));
    out.push(compacted(`a${i}`, 'long '.repeat(4000), `condensed answer ${i}: ` + 'c'.repeat(8000)));
  }
  for (let i = 13; i <= 16; i++) { out.push(plain(`u${i}`, 'user', `new request ${i}`)); out.push(plain(`a${i}`, 'assistant', 'fresh '.repeat(3000))); }
  return out;
};

test('rolling: no merge under budget; over it, the oldest compacted stretch (and the old summary) merge, cut at a user message', async () => {
  const { planMerge, compactedEnd } = await import('../extensions/lib/edit-compact.ts');
  const projected = rolling();
  const cut = projected.length - 2;
  const items = buildMap(projected, 1, cut);
  assert.equal(projected[compactedEnd(items, cut)].sourceEntry.id, 'u13', 'compacted part ends where new turns start');
  assert.equal(planMerge(projected, items, cut, 100_000), undefined, 'under budget');
  assert.equal(planMerge(projected, items, cut, 0), undefined, 'budget off');
  const m = planMerge(projected, items, cut, 20_000);
  assert.ok(m, 'over budget');
  assert.equal(projected[m.keepIndex].messages[0].role, 'user', 'kept range starts at a user message');
  assert.ok(m.hasSummary);
  assert.equal(m.fromN, 1);
  assert.ok(m.compactedTokens > 20_000 && m.tokens < m.compactedTokens);
  assert.ok(m.compactedTokens - m.tokens <= 20_000, 'what stays compacted is within the budget');
  assert.ok(m.users.length >= 2 && m.users[0].id === 'u1');
});

test('rolling: merge summary lists the user\'s messages with recall IDs and carries an earlier index, capped', async () => {
  const { planMerge, mergeSummary, splitMergeOps, USER_INDEX_MAX, editRequest } = await import('../extensions/lib/edit-compact.ts');
  const projected = rolling();
  const cut = projected.length - 2;
  const items = buildMap(projected, 1, cut);
  const m = planMerge(projected, items, cut, 20_000);
  const r = editRequest('the user message', items, 0, { merge: m });
  assert.match(r, /\{"op":"merge","text":"\.\.\."\}/);
  assert.match(r, /together with the earlier summary/);
  const plan = [{ op: 'merge', text: 'Goal: X. Decided Y.' }, { op: 'condense', n: m.fromN, text: 'z' }, { op: 'condense', n: m.toN + 1, text: 'kept' }];
  const s = splitMergeOps(plan, items, m);
  assert.equal(s.note, 'Goal: X. Decided Y.');
  assert.deepEqual(s.ops.map(o => o.n), [m.toN + 1], 'ops inside the merged stretch are dropped');
  assert.match(s.skipped[0], /inside the merged stretch/);
  const noNote = splitMergeOps([{ op: 'condense', n: m.fromN, text: 'z' }], items, m);
  assert.equal(noNote.ops.length, 1, 'without a note nothing is merged and the ops stay');
  const carried = Array.from({ length: USER_INDEX_MAX }, (_, i) => ({ id: `old${i}`, opening: 'older' }));
  const out = mergeSummary('Goal: X.', m, carried, 3);
  assert.match(out.summary, /context_recall\("<id>"\)/);
  assert.match(out.summary, /- u1: "old request 1"/);
  assert.equal(out.users.length, USER_INDEX_MAX);
  assert.equal(out.older, 3 + m.users.length);
  assert.match(out.summary, new RegExp(`${3 + m.users.length} older ones are not listed`));
});

test('native: rolling merge writes a compaction entry next to the edits; the next request has note, index and newer turns', { skip: !root }, async () => {
  const [{ createAgentSession }, { SettingsManager }, { SessionManager }, { loadExtensions }, { AssistantMessageEventStream }] = await Promise.all([
    native('dist/core/sdk.js'), native('dist/core/settings-manager.js'), native('dist/core/session-manager.js'),
    native('dist/core/extensions/loader.js'),
    import(pathToFileURL(piDependency(root, '@earendil-works/pi-ai', 'dist/utils/event-stream.js')).href)]);
  const model = { id: 'claude-opus-5-5', name: 'Opus', api: 'claude-code-stream-json', provider: 'claude-code', reasoning: true,
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 8000 };
  const usage = (cacheRead = 0) => ({ input: 5, output: 5, cacheRead, cacheWrite: 10, totalTokens: 20 + cacheRead,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const base = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: usage() };
  const say = text => ({ ...base, stopReason: 'stop', content: [{ type: 'text', text }] });
  const plan = json => ({ ...base, usage: usage(50_000), stopReason: 'stop', content: [{ type: 'text', text: '```json\n' + json + '\n```' }] });
  const requests = [];
  const queue = [];
  const runtime = { getModel: () => model, getPhysicalModel: () => model, hasConfiguredAuth: () => true, isUsingOAuth: () => true,
    getAvailableSnapshot: () => [model],
    async streamSimple(_m, context) {
      requests.push(structuredClone(context.messages));
      const r = queue.shift(); assert.ok(r, 'unexpected extra model request');
      const msg = typeof r === 'function' ? r(context) : r;
      const s = new AssistantMessageEventStream(); s.push({ type: 'done', reason: msg.stopReason, message: msg }); s.end(); return s;
    } };
  const loaded = await loadExtensions([resolve('extensions/pi-warm-compact.ts')], process.cwd());
  const resourceLoader = { getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {} };
  const manager = SessionManager.inMemory(process.cwd());
  const { session } = await createAgentSession({ cwd: process.cwd(), model, thinkingLevel: 'medium', modelRuntime: runtime,
    sessionManager: manager, resourceLoader, tools: ['context_recall'], customTools: [],
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' }) });
  const notes = [];
  await session.bindExtensions?.({ uiContext: { notify: (m, t) => notes.push(`${t}:${m}`) } });
  const run = async (cmd, reply) => {
    queue.push(reply);
    await session.prompt(cmd);
    for (let i = 0; i < 50 && queue.length; i++) await new Promise(r => setTimeout(r, 10));
    await session.waitForIdle();
  };
  const turn = async (i, size) => { queue.push(say(`Answer ${i}. ` + 'w'.repeat(size))); await session.prompt(`Task ${i}`); };
  // First pass: condense every old answer the map lists.
  for (let i = 1; i <= 8; i++) await turn(i, 40_000);
  const condenseAll = context => {
    const req = JSON.stringify(context.messages.at(-1));
    const ns = [...req.matchAll(/#(\d+) assistant ~\d+ tok/g)].map(m => Number(m[1]));
    return plan(JSON.stringify({ edits: ns.map(n => ({ op: 'condense', n, text: `condensed ${n}: ` + 'c'.repeat(6000) })) }));
  };
  await run('/warm-compact keep=20k budget=off', condenseAll);
  // More work, then a second pass with a small budget: the oldest compacted stretch is merged.
  for (let i = 9; i <= 14; i++) await turn(i, 40_000);
  let mergeAsked = '';
  await run('/warm-compact keep=20k budget=5k', context => {
    mergeAsked = JSON.stringify(context.messages.at(-1));
    return plan(JSON.stringify({ edits: [{ op: 'merge', text: 'MERGED NOTE: tasks 1-4 done, decision D kept.' }] }));
  });
  const status = manager.getBranch().filter(e => e.type === 'custom' && e.customType === 'pi-warm-compact-status').map(e => e.data);
  assert.deepEqual(status.map(s => s.phase), ['start', 'done', 'start', 'done'], `${notes.join(' | ')} ${JSON.stringify(status)}`);
  assert.match(mergeAsked, /over its budget/);
  assert.match(status[3].text, /merged into a/);
  const comp = manager.getBranch().filter(e => e.type === 'compaction');
  assert.equal(comp.length, 1);
  assert.equal(comp[0].details.mode, 'rolling');
  queue.push(say('ok'));
  await session.prompt('Next task');
  const flat = JSON.stringify(requests.at(-1));
  assert.ok(flat.includes('MERGED NOTE: tasks 1-4 done'), 'the note is in the context');
  assert.ok(flat.includes('context_recall(\\"<id>\\")'), 'with the recall index');
  assert.ok(!flat.includes('condensed 2: '), 'the merged stretch is gone');
  assert.ok(flat.includes('Task 14'), 'recent turns stay');
  // Answers 1-6 were condensed by the first pass: whether merged or kept, none comes back in full.
  for (let i = 1; i <= 6; i++) assert.ok(!flat.includes(`Answer ${i}. www`), `answer ${i} stays compacted after the merge`);
  assert.ok(/condensed \d+: c/.test(flat), 'first-pass edits on kept entries still apply');
  assert.ok(!flat.includes('[pi-warm-compact request]'), 'instructions hidden');
  // Recall still works for a merged user message.
  const u1 = comp[0].details.users[0];
  assert.ok(u1?.id, 'index lists the user\'s first message');
  queue.push({ ...base, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'tc9', name: 'context_recall', arguments: { id: u1.id } }] }, say('done'));
  await session.prompt('Recall the first task.');
  assert.ok(JSON.stringify(requests.at(-1)).includes('Task 1'), 'context_recall returns the merged original');
});
