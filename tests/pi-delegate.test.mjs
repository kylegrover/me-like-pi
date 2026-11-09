import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runDelegate, sharedPayload, workerInstructions } from '../extensions/lib/delegation-run.ts';
import { workerThinking } from '../extensions/lib/worker-model.ts';
import { loadDelegationNative } from './helpers/delegation-native.mjs';
import { syntheticAssistant, syntheticTranscript } from '../scripts/lib/delegation-context-spike.mjs';

const root = process.env.PI_PACKAGE_ROOT;
const native = root ? loadDelegationNative(root) : undefined;

test('shared payload changes only affinity and rejects context/control drift', () => {
  const parent = { input: [{ role: 'user', content: 'context' }], model: 'same', prompt_cache_key: 'parent' };
  const child = { ...parent, input: [...parent.input, { role: 'user', content: 'task' }], prompt_cache_key: 'child' };
  assert.deepEqual(sharedPayload(parent, child), { ...child, prompt_cache_key: 'parent' });
  assert.equal(child.prompt_cache_key, 'child');
  const { prompt_cache_key, ...disabled } = parent;
  assert.equal(Object.hasOwn(sharedPayload(disabled, child), 'prompt_cache_key'), false);
  assert.throws(() => sharedPayload(parent, { ...child, input: child.input.slice(1) }), /prefix/);
  assert.throws(() => sharedPayload(parent, { ...child, model: 'other' }), /controls/);
  assert.match(workerInstructions('Update our notes'), /Update our notes/);
  assert.match(workerInstructions('Read the marker'), /Earlier instructions to invoke delegate were for the parent and are already satisfied/);
  assert.match(workerInstructions('Read the marker'), /Perform the assignment below yourself using your local tools/);
  assert.doesNotMatch(workerInstructions('Update our notes'), /staging|allowlist|proposal/);
});

async function setup(t, replies, extra = {}) {
  const n = await native, model = extra.model ?? n.models[1];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-v1-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'workspace');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'notes.md'), 'User dirty edit\nold decision\n');
  const [{ createAgentSession }, { SettingsManager }, { createExtensionRuntime }, { AssistantMessageEventStream }] = await Promise.all([
    n.native('dist/core/sdk.js'), n.native('dist/core/settings-manager.js'),
    n.native('dist/core/extensions/loader.js'), n.ai('utils/event-stream.js'),
  ]);
  const sdk = { ...await n.native('dist/index.js'), createAgentSession, SettingsManager, createExtensionRuntime,
    SessionManager: n.SessionManager, convertToLlm: n.convertToLlm };
  const messages = syntheticTranscript(model);
  const definitions = [sdk.createReadToolDefinition(cwd), sdk.createEditToolDefinition(cwd),
    sdk.createBashToolDefinition(cwd), sdk.createWriteToolDefinition(cwd)];
  messages[0].toolsAdded = [...definitions.map(n.toToolDeclaration), messages[0].toolsAdded.find(t => t.name === 'delegate')];
  messages[3].toolsAdded = [n.toToolDeclaration(sdk.createFindToolDefinition(cwd))];
  const responses = ['openai-responses', 'openai-codex-responses'].includes(model.api);
  const snapshot = { sessionId: 'parent-owner', model, thinkingLevel: extra.thinkingLevel ?? 'medium', messages,
    payload: responses ? await n.capture(model, messages, 'parent-affinity', true) : undefined };
  const requests = [];
  const runtime = {
    getModel: () => model, getPhysicalModel: () => model,
    hasConfiguredAuth: () => true, isUsingOAuth: () => true, getAvailableSnapshot: () => [model],
    async streamSimple(selected, context, options) {
      assert.equal(options.maxRetries, 0, 'provider retries disabled by the real SDK settings');
      assert.equal(options.transport, 'sse');
      // Actual provider serialization, fake subscription-shaped credentials, no transport.
      const payload = responses ? await n.capture(selected, context.messages, options.sessionId, true,
        { reasoningEffort: options.reasoning }) : undefined;
      // Custom providers such as pi-claude-code may omit onPayload completely.
      const effective = responses ? await options.onPayload(payload) : undefined;
      requests.push({ payload: effective, sessionId: options.sessionId, context: structuredClone(context),
        reasoning: options.reasoning });
      await extra.beforeReply?.(requests.length);
      const stream = new AssistantMessageEventStream();
      const content = replies.shift();
      const response = syntheticAssistant(model, content ?? [{ type: 'text', text: 'Updated notes.md. Checked content; no tests run.' }],
        content?.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop');
      response.usage.input = 7;
      response.usage.output = 3;
      response.usage.totalTokens = 10;
      stream.push({ type: 'done', reason: response.stopReason, message: response });
      stream.end();
      return stream;
    },
  };
  return { n, sdk, cwd, dir, snapshot, runtime, requests, run: opts => runDelegate(sdk, {
    snapshot, cwd, task: 'Update the old decision in notes.md to agreed decision.',
    evidenceDir: path.join(dir, 'evidence'), modelRuntime: runtime, ...opts,
  }) };
}
const call = (name, args, i) => [{ type: 'toolCall', name, id: `call_${i}|fc_${i}`, arguments: args }];

async function claudeModel(provider = 'claude-code', api = 'claude-code-stream-json') {
  const n = await native;
  const { ANTHROPIC_MODELS } = await n.ai('providers/anthropic.models.js');
  assert.ok(ANTHROPIC_MODELS['claude-opus-5-5']);
  return { ...ANTHROPIC_MODELS['claude-opus-5-5'], provider, api };
}

test('thinking policy inherits any active model and restricts changed effort to OpenAI', () => {
  for (const provider of ['claude-code', 'anthropic', 'custom']) {
    const model = { provider, api: 'custom' };
    assert.equal(workerThinking(model, 'high'), 'high');
    assert.equal(workerThinking(model, 'high', 'high'), 'high');
    assert.throws(() => workerThinking(model, 'high', 'low'), /only OpenAI/);
  }
  assert.throws(() => workerThinking({ provider: 'anthropic', api: 'openai-responses' }, 'high', 'low'), /only OpenAI/);
  assert.equal(workerThinking({ provider: 'openai', api: 'openai-responses' }, 'high', 'low'), 'low');
  assert.throws(() => workerThinking({ provider: 'openai' }, 'high', 'invalid'), /Invalid/);
});

test('explicit OpenAI effort changes retain all other wire controls', () => {
  const parent = { input: ['prefix'], model: 'same', reasoning: { effort: 'medium', summary: 'auto' },
    include: ['reasoning.encrypted_content'], prompt_cache_key: 'parent' };
  const child = { ...parent, input: ['prefix', 'task'], reasoning: { effort: 'high', summary: 'auto' } };
  assert.throws(() => sharedPayload(parent, child), /controls/);
  assert.equal(sharedPayload(parent, child, true).reasoning.effort, 'high');
  assert.throws(() => sharedPayload(parent, { ...child, temperature: 0.7 }, true), /controls/);
  assert.throws(() => sharedPayload(parent, { ...child, reasoning: { effort: 'high', summary: 'detailed' } }, true), /controls/);
  const off = { ...child, reasoning: { effort: 'none' }, include: undefined };
  assert.equal(sharedPayload(parent, off, true).reasoning.effort, 'none');
});

test('native OpenAI worker selects supported effort, retains prefix/affinity and rejects clamping', { skip: !root }, async t => {
  const n = await native;
  for (const thinkingLevel of ['low', 'high', 'off']) {
    // Installed Astra disallows off; exercise the serializer's supported-off path
    // with explicit fixture capabilities rather than claiming Astra supports it.
    const model = thinkingLevel === 'off' ? { ...n.models[1],
      thinkingLevelMap: { ...n.models[1].thinkingLevelMap, off: 'none' } } : n.models[1];
    const f = await setup(t, [], { model });
    const result = await f.run({ thinkingLevel });
    assert.equal(result.isError, false, result.content[0].text);
    assert.equal(result.details.thinkingLevel, thinkingLevel);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].reasoning, thinkingLevel === 'off' ? undefined : thinkingLevel);
    assert.equal(f.requests[0].payload.prompt_cache_key, 'parent-affinity');
    assert.deepEqual(f.requests[0].payload.input.slice(0, f.snapshot.payload.input.length), f.snapshot.payload.input);
    const saved = f.n.SessionManager.open(result.details.sessionFile).getBranch();
    assert.equal(saved.find(e => e.customType === 'delegate-origin').data.thinkingLevel, thinkingLevel);
  }
  const unsupported = await setup(t, []);
  const off = await unsupported.run({ thinkingLevel: 'off' });
  assert.equal(off.isError, true, 'installed Astra must not silently clamp off');
  assert.equal(unsupported.requests.length, 0);
  const f = await setup(t, [], { model: { ...n.models[1], reasoning: false } });
  const result = await f.run({ thinkingLevel: 'high' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requested setting/);
  assert.equal(f.requests.length, 0);
});

test('native Claude/custom workers need no payload hook, inherit context/effort, edit and enforce request limit', { skip: !root }, async t => {
  for (const [provider, api, thinkingLevel = 'medium'] of [
    ['claude-code', 'claude-code-stream-json'], ['anthropic', 'anthropic-messages'],
    ['custom', 'custom-api'], ['custom-plain', 'custom-api', 'off'],
  ]) {
    const model = await claudeModel(provider, api);
    if (thinkingLevel === 'off') model.reasoning = false;
    const f = await setup(t, [call('write', { path: 'claude.txt', content: provider }, 1)], { model, thinkingLevel });
    const result = await f.run({ maxTurns: 1 });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /stopped after 1 requests/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].reasoning, thinkingLevel === 'off' ? undefined : thinkingLevel);
    assert.equal(fs.readFileSync(path.join(f.cwd, 'claude.txt'), 'utf8'), provider);
    assert.equal(result.usage.totalTokens, 10);
    assert.notEqual(f.requests[0].sessionId, f.snapshot.sessionId);
    assert.doesNotMatch(JSON.stringify(f.requests[0].context), /No result provided/);
    assert.deepEqual(f.requests[0].context.messages.slice(0, f.snapshot.messages.length), f.snapshot.messages);
    assert.equal(result.details.provider, provider);
    assert.equal(result.details.thinkingLevel, thinkingLevel);
    assert.ok(fs.existsSync(result.details.sessionFile));
    await assert.rejects(f.run({ thinkingLevel: 'low' }), /only OpenAI/);
    assert.equal(f.requests.length, 1, 'rejected effort must not dispatch');
    const success = await f.run();
    assert.equal(success.isError, false, success.content[0].text);
    assert.equal(success.details.thinkingLevel, thinkingLevel);
  }
});

test('native generic worker preserves projected summaries and rejects post-restore context drift', { skip: !root }, async t => {
  const f = await setup(t, [], { model: await claudeModel() });
  f.snapshot.messages.splice(1, 0, { role: 'branchSummary', summary: 'Earlier work remains relevant.',
    fromId: 'old-branch', timestamp: 0 });
  const before = structuredClone(f.snapshot.messages);
  const result = await f.run();
  assert.equal(result.isError, false, result.content[0].text);
  assert.deepEqual(f.snapshot.messages, before);
  assert.match(JSON.stringify(f.requests[0].context), /Earlier work remains relevant/);
  const saved = f.n.SessionManager.open(result.details.sessionFile).getBranch();
  assert.ok(!saved.some(e => e.type === 'message' && e.message.role === 'branchSummary'));
  const create = f.sdk.createAgentSession;
  f.sdk.createAgentSession = async options => {
    const created = await create(options);
    const stream = created.session.agent.streamFunction;
    created.session.agent.streamFunction = (model, context, requestOptions) => {
      context.messages[0].content = 'post-restore context tampering';
      return stream(model, context, requestOptions);
    };
    return created;
  };
  const rejected = await f.run();
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /logical context prefix/);
  assert.equal(f.requests.length, 1, 'drift must be rejected before reaching the provider');
});

test('worker codemode executes local tools, preserves declarations and refuses nested delegation', { skip: !root }, async t => {
  const f = await setup(t, [], { model: await claudeModel() });
  const seed = await f.run();
  assert.equal(seed.isError, false, seed.content[0].text);
  // Seed uses the actual SDK's codemode declaration, not a handcrafted approximation.
  f.snapshot.messages = structuredClone(f.requests[0].context.messages);
  const original = structuredClone(f.snapshot.messages);
  const state = f.n.getCurrentTools(original);
  assert.ok(state.some(tool => tool.name === 'codemode' && tool.constrainedSampling));
  const calls = [call('codemode', { code: `
    text(await tools.read({ path: 'notes.md' }));
    text(await tools.bash({ command: 'printf codemode-shell-ok' }));
    text(await tools.write({ path: 'codemode.txt', content: 'independent' }));
    try { await tools.delegate({ task: 'must not run' }); } catch (error) { text(error.message); }
  ` }, 1), call('delegate', { path: 'unused' }, 2)];
  const g = await setup(t, calls, { model: f.snapshot.model });
  g.snapshot.messages = original;
  const result = await g.run();
  assert.equal(result.isError, false, result.content[0].text);
  assert.equal(result.details.toolErrors, 1, 'refused direct delegate remains visible despite a normal final response');
  assert.match(result.content[0].text, /1 tool error\(s\); inspect its report/);
  assert.equal(fs.readFileSync(path.join(g.cwd, 'codemode.txt'), 'utf8'), 'independent');
  const saved = g.n.SessionManager.open(result.details.sessionFile).getBranch();
  const text = JSON.stringify(saved.filter(entry => entry.message?.role === 'toolResult'));
  assert.match(text, /codemode-shell-ok/);
  assert.match(text, /Nested delegation is disabled/);
  assert.match(text, /tools\.delegate does not exist/);
  assert.equal(saved.filter(entry => entry.customType === 'delegate-origin').length, 1);
  const messages = g.requests[0].context.messages;
  assert.deepEqual(messages.slice(0, original.length), original);
  assert.deepEqual(g.n.getCurrentTools(messages), state);
  assert.equal(g.n.hasToolRedefinitions(messages), false);
  assert.ok(!messages.slice(original.length).some(message => message.role === 'system' &&
    (message.toolsAdded?.length || message.toolsRemoved?.length)), 'no worker tool swap');
});

test('worker role clarification follows inherited parent orchestration without rewriting either API prefix', { skip: !root }, async t => {
  const n = await native;
  for (const model of [await claudeModel(), ...n.models]) {
    const f = await setup(t, [], { model });
    f.snapshot.messages.push({ role: 'user', content: 'Now invoke delegate exactly once; do not use any other tools.', timestamp: 5 });
    if (f.snapshot.payload) f.snapshot.payload = await n.capture(model, f.snapshot.messages, 'parent-affinity', true);
    const result = await f.run({ task: 'Read the marker yourself.' });
    assert.equal(result.isError, false, result.content[0].text);
    const messages = f.requests[0].context.messages;
    assert.deepEqual(messages.slice(0, f.snapshot.messages.length), f.snapshot.messages);
    const assignment = JSON.stringify(messages.at(-1).content);
    assert.match(assignment, /Earlier instructions to invoke delegate were for the parent and are already satisfied/);
    assert.match(assignment, /Assignment:\\nRead the marker yourself\./);
    if (f.snapshot.payload) assert.deepEqual(f.requests[0].payload.input.slice(0, f.snapshot.payload.input.length), f.snapshot.payload.input);
  }
});

test('worker reports caught nested tool errors without treating normal completion as task success', { skip: !root }, async t => {
  const f = await setup(t, [call('codemode', { code: `
    try { await tools.read({ path: 'missing-file.txt' }); } catch (error) { text(error.message); }
  ` }, 1)], { model: await claudeModel() });
  const result = await f.run();
  assert.equal(result.isError, false, result.content[0].text);
  assert.equal(result.details.toolErrors, 1);
  assert.match(result.content[0].text, /1 tool error/);
  const saved = f.n.SessionManager.open(result.details.sessionFile).getBranch();
  assert.equal(saved.findLast(entry => entry.customType === 'delegate-result').data.toolErrors, 1);
});

test('legacy summary-first context retains summary, later system/tools, and request prefix', { skip: !root }, async t => {
  const f = await setup(t, [call('read', { path: 'notes.md' }, 1)], { model: await claudeModel() });
  f.snapshot.messages.unshift({ role: 'compactionSummary', summary: 'Keep the legacy project decisions.',
    tokensBefore: 100, firstKeptEntryId: 'old', timestamp: 0 });
  const expected = f.n.convertToLlm(structuredClone(f.snapshot.messages));
  const result = await f.run();
  assert.equal(result.isError, false, result.content[0].text);
  assert.deepEqual(f.requests[0].context.messages.slice(0, expected.length), expected);
  assert.match(JSON.stringify(f.requests[1].context), /old decision/);
  assert.equal(f.n.hasToolRedefinitions(f.requests[0].context.messages), false);
  assert.deepEqual(f.n.getCurrentTools(f.requests[0].context.messages).filter(tool => tool.name !== 'codemode'),
    f.n.getCurrentTools(expected));
  f.snapshot.messages = f.snapshot.messages.filter(message => message.role !== 'system');
  await assert.rejects(f.run(), /No complete parent context/);
});

test('unavailable inherited extension tool returns a recoverable error and is disclosed in assignment', { skip: !root }, async t => {
  const f = await setup(t, [call('extension_only', {}, 1)], { model: await claudeModel() });
  f.snapshot.messages[0].toolsAdded.push({ name: 'extension_only', description: 'Parent-only extension.',
    parameters: { type: 'object', properties: {} } });
  const result = await f.run();
  assert.equal(result.isError, false, result.content[0].text);
  assert.match(JSON.stringify(f.requests[0].context.messages.at(-1)), /unavailable here: extension_only/);
  assert.match(JSON.stringify(f.requests[1].context.messages), /extension_only is unavailable in this independent worker/);
});

test('native Claude parent context hooks capture a matching delegate without before_provider_request', { skip: !root }, async t => {
  const f = await setup(t, [], { model: await claudeModel() });
  const { loadExtensions } = await f.n.native('dist/core/extensions/loader.js');
  const loaded = await loadExtensions([path.resolve('extensions/pi-delegate.ts')], f.cwd);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0], audit = [];
  loaded.runtime.getAllTools = () => [];
  loaded.runtime.appendEntry = (type, data) => audit.push(data);
  loaded.runtime.getActiveTools = () => ['delegate'];
  const tool = extension.tools.get('delegate').definition;
  const { validateToolArguments } = await f.n.ai('utils/validation.js');
  assert.deepEqual(validateToolArguments(tool, { id: 'test', name: 'delegate',
    arguments: { task: 'Read only.', thinkingLevel: 'high' } }), { task: 'Read only.', thinkingLevel: 'high' });
  assert.throws(() => validateToolArguments(tool, { id: 'test', name: 'delegate',
    arguments: { task: 'Read only.', thinkingLevel: 'invalid' } }));
  const { ENV_AGENT_DIR } = await f.n.native('dist/config.js');
  const previous = process.env[ENV_AGENT_DIR];
  process.env[ENV_AGENT_DIR] = path.join(f.dir, 'agent');
  t.after(() => { if (previous === undefined) delete process.env[ENV_AGENT_DIR]; else process.env[ENV_AGENT_DIR] = previous; });
  const ctx = { cwd: f.cwd, model: f.snapshot.model, thinkingLevel: 'medium',
    sessionManager: { getSessionId: () => f.snapshot.sessionId, getLeafId: () => 'leaf', getBranch: () => [] },
    modelRegistry: { find: () => f.snapshot.model, getAvailable: () => [f.snapshot.model],
      hasConfiguredAuth: () => true, isUsingOAuth: () => true, streamSimple: f.runtime.streamSimple },
  };
  const emit = async (name, event) => { for (const fn of extension.handlers.get(name) ?? []) await fn(event, ctx); };
  const ready = async id => {
    await emit('turn_start', {});
    await emit('context_with_system', { messages: f.snapshot.messages });
    await emit('message_end', { message: syntheticAssistant(f.snapshot.model,
      [{ type: 'toolCall', id, name: 'delegate', arguments: { task: 'Read only.' } }], 'toolUse') });
  };
  await ready('claude_parent_tool');
  const result = await tool.execute('claude_parent_tool', { task: 'Read only.' }, undefined, undefined, ctx);
  assert.equal(result.isError, false, result.content[0].text);
  assert.ok(audit.some(e => e.kind === 'request' && e.provider === 'claude-code' &&
    e.capture === 'context_with_system' && e.api === 'claude-code-stream-json' && e.implementation === 'v2-context-audit-1'));
  assert.ok(audit.some(e => e.kind === 'outcome' && e.status === 'completed' && e.workerThinkingLevel === 'medium'));
  assert.doesNotMatch(JSON.stringify(f.requests[0].context), /claude_parent_tool/);
  await assert.rejects(tool.execute('claude_parent_tool', { task: 'Again' }, undefined, undefined, ctx), /No matching/);
  await ready('claude_override');
  await assert.rejects(tool.execute('claude_override', { task: 'Read only.', thinkingLevel: 'low' }, undefined, undefined, ctx), /only OpenAI/);
  await ready('stale');
  ctx.model = { ...ctx.model, id: 'another-model' };
  await assert.rejects(tool.execute('stale', { task: 'Read only.' }, undefined, undefined, ctx), /No matching/);
  assert.equal(f.requests.length, 1);
});

test('native shared worker directly edits real workspace and returns only receipt + new usage', { skip: !root }, async t => {
  const f = await setup(t, [call('read', { path: 'notes.md' }, 1),
    call('edit', { path: 'notes.md', edits: [{ oldText: 'old decision', newText: 'agreed decision' }] }, 2)]);
  const before = JSON.stringify(f.snapshot);
  const result = await f.run();
  assert.equal(result.isError, false, result.content[0].text);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'notes.md'), 'utf8'), 'User dirty edit\nagreed decision\n');
  assert.equal(JSON.stringify(f.snapshot), before);
  assert.equal(f.requests.length, 3);
  assert.notEqual(result.details.sessionId, f.snapshot.sessionId);
  for (const req of f.requests) {
    assert.equal(req.sessionId, result.details.sessionId);
    assert.equal(req.payload.prompt_cache_key, 'parent-affinity');
    assert.deepEqual(req.payload.input.slice(0, f.snapshot.payload.input.length), f.snapshot.payload.input);
  }
  assert.equal(result.usage.totalTokens, 30);
  assert.ok(result.content[0].text.length < 600);
  assert.doesNotMatch(result.content[0].text, /User dirty edit/);
  const saved = f.n.SessionManager.open(result.details.sessionFile);
  assert.match(JSON.stringify(saved.getBranch()), /agreed decision/);
  assert.match(JSON.stringify(saved.getBranch()), /delegate-origin/);
});

test('native worker has normal bash and source write access, with no directory manifest', { skip: !root }, async t => {
  const f = await setup(t, [call('bash', { command: 'printf worker-shell-ok' }, 1),
    call('write', { path: 'source.txt', content: 'direct worker write' }, 2)]);
  const result = await f.run({ task: 'Run a shell command and create source.txt.' });
  assert.equal(result.isError, false, result.content[0].text);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'source.txt'), 'utf8'), 'direct worker write');
  const saved = f.n.SessionManager.open(result.details.sessionFile);
  assert.match(JSON.stringify(saved.getBranch()), /worker-shell-ok/);
});

test('request limit leaves completed edits in place and returns partial-failure evidence', { skip: !root }, async t => {
  const f = await setup(t, [call('write', { path: 'partial.txt', content: 'done' }, 1)]);
  const result = await f.run({ maxTurns: 1 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /stopped after 1 requests/);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'partial.txt'), 'utf8'), 'done');
  assert.equal(f.requests.length, 1);
  assert.equal(result.usage.totalTokens, 10);
  assert.ok(fs.existsSync(result.details.sessionFile));
});

test('time limit returns incomplete with recoverable session evidence', { skip: !root }, async t => {
  const f = await setup(t, [],
    { beforeReply: async () => { await new Promise(resolve => setTimeout(resolve, 80)); } });
  const result = await f.run({ timeoutMs: 20 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /time limit/);
  assert.ok(fs.existsSync(result.details.sessionFile));
});

test('incompatible effective parent controls fail before any worker model dispatch', { skip: !root }, async t => {
  const f = await setup(t, []);
  f.snapshot.payload.instructions = 'request-local replacement not present in captured messages';
  const result = await f.run();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /controls/);
  assert.equal(f.requests.length, 0);
  assert.equal(result.usage.totalTokens, 0);
  delete f.snapshot.payload;
  await assert.rejects(f.run(), /parent request payload was not captured/);
  assert.equal(f.requests.length, 0);
});

test('native loader registers the active-model tool; actual parent hooks dispatch an independent worker', { skip: !root }, async t => {
  const f = await setup(t, []);
  const { loadExtensions } = await f.n.native('dist/core/extensions/loader.js');
  const loaded = await loadExtensions([path.resolve('extensions/pi-delegate.ts')], f.cwd);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const auditEntries = [];
  loaded.runtime.getAllTools = () => [];
  loaded.runtime.appendEntry = (customType, data) => auditEntries.push({ customType, data });
  loaded.runtime.getActiveTools = () => ['delegate'];
  assert.deepEqual([...extension.tools.keys()], ['delegate', 'delegate_history']);
  const tool = extension.tools.get('delegate').definition;
  assert.equal(tool.executionMode, 'sequential');
  assert.equal(tool.exposure, 'model-only');
  const { ENV_AGENT_DIR } = await f.n.native('dist/config.js');
  const previous = process.env[ENV_AGENT_DIR];
  process.env[ENV_AGENT_DIR] = path.join(f.dir, 'agent');
  t.after(() => { if (previous === undefined) delete process.env[ENV_AGENT_DIR]; else process.env[ENV_AGENT_DIR] = previous; });
  const ctx = { cwd: f.cwd, model: f.snapshot.model, thinkingLevel: 'medium',
    sessionManager: { getSessionId: () => f.snapshot.sessionId, getLeafId: () => 'parent-leaf',
      getBranch: () => [{ type: 'message', id: 'user-entry', message: { role: 'user', content: 'private user text' } }] },
    modelRegistry: { find: () => f.snapshot.model, getAvailable: () => [f.snapshot.model],
      hasConfiguredAuth: () => true, isUsingOAuth: () => true,
      streamSimple: f.runtime.streamSimple },
  };
  const emit = async (name, event) => {
    for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
  };
  await assert.rejects(tool.execute('call_dispatch', { task: 'Do it' }, undefined, undefined, ctx), /No matching/);
  await emit('turn_start', {});
  await emit('context_with_system', { messages: f.snapshot.messages });
  await emit('before_provider_request', { payload: f.snapshot.payload });
  await emit('message_end', { message: syntheticAssistant(f.snapshot.model,
    [{ type: 'toolCall', id: 'call_dispatch', name: 'delegate', arguments: { task: 'Do it' } }], 'toolUse') });
  const result = await tool.execute('call_dispatch', { task: 'Do it' }, undefined, undefined, ctx);
  assert.equal(result.isError, false, result.content[0].text);
  assert.match(result.details.sessionFile, /delegates/);
  assert.doesNotMatch(JSON.stringify(f.requests[0].context), /call_dispatch|No result provided|delegate-audit/);
  const config = auditEntries.find(e => e.data.kind === 'configuration').data;
  const request = auditEntries.find(e => e.data.kind === 'request').data;
  const outcome = auditEntries.find(e => e.data.kind === 'outcome' && e.data.status === 'completed').data;
  assert.equal(request.delegateActive, true);
  assert.equal(request.userEntryId, 'user-entry');
  assert.equal(outcome.requestId, request.requestId);
  assert.equal(outcome.toolCallId, 'call_dispatch');
  assert.equal(outcome.workerSessionFile, result.details.sessionFile);
  assert.equal(outcome.guidanceId, config.guidanceId);
  const origin = f.n.SessionManager.open(result.details.sessionFile).getBranch()
    .find(e => e.type === 'custom' && e.customType === 'delegate-origin').data;
  assert.equal(origin.parentRequestId, request.requestId);
  assert.equal(origin.parentToolCallId, 'call_dispatch');
  assert.doesNotMatch(JSON.stringify(auditEntries), /private user text|Do it|parent-affinity/);
  assert.equal(auditEntries.filter(e => e.data.kind === 'configuration').length, 1);
  await emit('turn_start', {});
  await emit('context_with_system', { messages: f.snapshot.messages });
  await emit('before_provider_request', { payload: f.snapshot.payload });
  await emit('message_end', { message: syntheticAssistant(f.snapshot.model,
    [{ type: 'text', text: 'Private direct answer without delegation.' }]) });
  const direct = auditEntries.filter(e => e.data.kind === 'response').at(-1).data;
  assert.deepEqual(direct.calls, []);
  assert.notEqual(direct.requestId, request.requestId);
  assert.doesNotMatch(JSON.stringify(auditEntries), /Private direct answer/);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  ctx.modelRegistry.streamSimple = async (...args) => { entered(); await gate; return f.runtime.streamSimple(...args); };
  await emit('message_end', { message: syntheticAssistant(f.snapshot.model,
    [{ type: 'toolCall', id: 'call_second', name: 'delegate', arguments: { task: 'Do it' } }], 'toolUse') });
  const pending = tool.execute('call_second', { task: 'Do it' }, undefined, undefined, ctx);
  await started;
  await assert.rejects(tool.execute('anything', { task: 'Do it' }, undefined, undefined, ctx), /already running/);
  await emit('session_shutdown', {});
  release();
  const interrupted = await pending;
  assert.equal(interrupted.isError, true);
  assert.match(interrupted.content[0].text, /Cancelled/);
  assert.ok(auditEntries.some(e => e.data.status === 'rejected' && e.data.reason === 'worker-already-running'));
  assert.ok(auditEntries.some(e => e.data.status === 'incomplete'));
  await assert.rejects(tool.execute('call_dispatch', { task: 'Do it' }, undefined, undefined, ctx), /No matching/);
});

test('abort before start dispatches nothing; cancellation during a run returns incomplete', { skip: !root }, async t => {
  const controller = new AbortController();
  const f = await setup(t, [], { beforeReply: () => controller.abort() });
  const result = await f.run({ signal: controller.signal });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Cancelled/);
  await assert.rejects(f.run({ signal: controller.signal }), /abort/i);
  assert.equal(f.requests.length, 1);
});

test('/do forks the idle parent: extends the last request, verbatim task, no turn, stale snapshots refused', { skip: !root }, async t => {
  let onReply;
  const f = await setup(t, [], { beforeReply: n => onReply?.(n) });
  const { loadExtensions } = await f.n.native('dist/core/extensions/loader.js');
  const loaded = await loadExtensions([path.resolve('extensions/pi-delegate.ts')], f.cwd);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0], audit = [], sent = [], notices = [], widgets = [];
  let thinking = 'medium', idle = true, input;
  loaded.runtime.getAllTools = () => [];
  loaded.runtime.appendEntry = (type, data) => audit.push(data);
  loaded.runtime.getActiveTools = () => ['delegate'];
  loaded.runtime.getThinkingLevel = () => thinking;
  loaded.runtime.sendMessage = (message, options) => sent.push({ message, options });
  const { ENV_AGENT_DIR } = await f.n.native('dist/config.js');
  const previous = process.env[ENV_AGENT_DIR];
  process.env[ENV_AGENT_DIR] = path.join(f.dir, 'agent');
  t.after(() => { if (previous === undefined) delete process.env[ENV_AGENT_DIR]; else process.env[ENV_AGENT_DIR] = previous; });
  const branch = [{ type: 'message', id: 'u1', message: f.snapshot.messages.at(-1) }];
  const ctx = { cwd: f.cwd, model: f.snapshot.model, thinkingLevel: 'medium', hasUI: true,
    isIdle: () => idle, hasPendingMessages: () => false,
    ui: { notify: text => notices.push(text), setStatus() {}, setWidget: (key, lines) => widgets.push({ key, lines }),
      onTerminalInput: fn => { input = fn; return () => { input = undefined; }; } },
    sessionManager: { getSessionId: () => f.snapshot.sessionId, getLeafId: () => branch.at(-1).id, getBranch: () => branch },
    modelRegistry: { find: () => f.snapshot.model, getAvailable: () => [f.snapshot.model],
      hasConfiguredAuth: () => true, isUsingOAuth: () => true, streamSimple: f.runtime.streamSimple } };
  const emit = async (name, event) => { for (const fn of extension.handlers.get(name) ?? []) await fn(event, ctx); };
  const run = args => extension.commands.get('do').handler(args, ctx);
  await run('commit this'); assert.match(notices.at(-1), /Send the parent a message first/);
  await emit('turn_start', {});
  await emit('context_with_system', { messages: f.snapshot.messages });
  await emit('before_provider_request', { payload: f.snapshot.payload });
  const reply = syntheticAssistant(f.snapshot.model, [{ type: 'text', text: 'Parent final reply: notes are ready.' }]);
  await emit('message_end', { message: reply });
  branch.push({ type: 'message', id: 'a1', message: reply });
  for (const [setUp, pattern] of [[() => { idle = false; }, /idle/], [() => {}, /Usage/]]) {
    setUp(); await run(pattern.source === 'Usage' ? '  ' : 'x'); idle = true; assert.match(notices.at(-1), pattern);
  }
  assert.equal(f.requests.length, 0);
  await run('commit');
  assert.equal(f.requests.length, 1, notices.join('\n'));
  const context = f.requests[0].context.messages;
  const replyAt = context.findIndex(m => JSON.stringify(m).includes('Parent final reply'));
  assert.equal(replyAt, f.snapshot.messages.length, 'parent reply directly extends the captured request');
  assert.ok(context.at(-1).content[0].text.endsWith('directly (verbatim):\ncommit'));
  assert.equal(f.requests[0].payload.prompt_cache_key, 'parent-affinity');
  assert.deepEqual(f.requests[0].payload.input.slice(0, f.snapshot.payload.input.length), f.snapshot.payload.input);
  assert.equal(sent.length, 1); assert.equal(sent[0].options.triggerTurn, false);
  assert.equal(sent[0].message.customType, 'delegate-result');
  assert.match(sent[0].message.content, /^\[\/do worker result\] Task: commit\n\nUpdated notes\.md[\s\S]*Worker session: /);
  assert.equal(input, undefined, 'escape listener removed');
  assert.ok(widgets.length >= 2 && widgets.every(w => w.key === 'pi-do'));
  assert.deepEqual(widgets[0].lines.slice(0, 2), ['/do commit', 'worker running · 0s · 0 requests · 0 tool calls']);
  assert.equal(widgets.at(-1).lines, undefined, 'live panel removed when the result arrives');
  assert.equal(sent[0].message.details.status, 'completed'); assert.equal(sent[0].message.details.requests, 1);
  const call = audit.find(e => e.kind === 'call'), outcome = audit.find(e => e.kind === 'outcome');
  assert.equal(call.invokedBy, 'user'); assert.equal(call.extendedMessages, 1);
  assert.equal(outcome.status, 'completed'); assert.equal(outcome.toolCallId, call.toolCallId);
  // The worker's result entry itself is forkable context for a second /do.
  branch.push({ type: 'custom_message', id: 'r1', customType: 'delegate-result', content: sent[0].message.content, display: true });
  onReply = () => input('\x1b');
  await run('and push');
  assert.equal(f.requests.length, 2);
  assert.match(sent.at(-1).message.content, /^\[\/do worker incomplete\][\s\S]*Cancelled/);
  onReply = undefined;
  for (const [change, undo] of [
    [() => { thinking = 'high'; }, () => { thinking = 'medium'; }],
    [() => branch.push({ type: 'compaction', id: 'c1' }), () => branch.pop()],
    [() => branch.push({ type: 'model_change', id: 'm1' }), () => branch.pop()],
    [() => branch.splice(0, 1), () => branch.unshift({ type: 'message', id: 'u1', message: f.snapshot.messages.at(-1) })],
  ]) {
    change(); await run('again'); undo();
    assert.match(notices.at(-1), /No current parent request/);
  }
  assert.equal(f.requests.length, 2);
});

test('delegate guidance tells the model the worker already has the whole conversation', { skip: !root }, async () => {
  const n = await native;
  const { loadExtensions } = await n.native('dist/core/extensions/loader.js');
  const loaded = await loadExtensions([path.resolve('extensions/pi-delegate.ts')], process.cwd());
  const tool = loaded.extensions[0].tools.get('delegate').definition;
  assert.match(tool.description, /already has this ENTIRE conversation/);
  assert.match(tool.description, /Do not restate files, constraints, steps, checks/);
  assert.match(tool.parameters.properties.task.description, /one short sentence/);
  assert.ok(loaded.extensions[0].commands.has('do'));
});

test('worker progress: tool feed, request counts, live tool updates and one-header renderers', { skip: !root }, async t => {
  const f = await setup(t, [call('bash', { command: 'git   status\n--short' }, 1), call('read', { path: 'notes.md' }, 2)]);
  const seen = [];
  const result = await f.run({ onProgress: p => seen.push(p) });
  assert.equal(result.isError, false, result.content[0].text);
  const last = seen.at(-1);
  assert.deepEqual(last.recent, ['bash git status --short', 'read notes.md']);
  assert.equal(last.requests, 3); assert.equal(last.tools, 2);
  assert.equal(last.sessionFile, result.details.sessionFile);
  assert.equal(result.details.requests, 3); assert.equal(result.details.tools, 2);
  assert.equal(typeof result.details.elapsedMs, 'number');
  const throwing = await setup(t, []);
  assert.equal((await throwing.run({ onProgress: () => { throw new Error('render bug'); } })).isError, false,
    'a display failure never fails the worker');

  const { progressLines, summaryLine } = await import('../extensions/lib/delegation-view.ts');
  assert.deepEqual(progressLines({ startedAt: 0, requests: 1, tools: 1, recent: ['edit a.md'], sessionFile: '' }, 61_400),
    ['worker running · 61s · 1 request · 1 tool call', '  › edit a.md']);
  assert.equal(summaryLine({ status: 'completed', elapsedMs: 2000, requests: 2, tools: 0 }), 'completed · 2s · 2 requests · 0 tool calls');
  assert.equal(summaryLine({ isError: true }), 'incomplete');
  assert.equal(summaryLine({ status: 'completed', tools: 1, toolErrors: 1 }), 'completed · 1 tool call · 1 tool error');

  const { loadExtensions } = await f.n.native('dist/core/extensions/loader.js');
  const loaded = await loadExtensions([path.resolve('extensions/pi-delegate.ts')], f.cwd);
  const extension = loaded.extensions[0];
  const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: s => s };
  const plain = c => c.render(200).join('\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');
  const tool = extension.tools.get('delegate').definition;
  assert.match(plain(tool.renderResult({ content: [{ type: 'text', text: 'x' }],
    details: { progress: { startedAt: Date.now(), requests: 2, tools: 1, recent: ['bash ls'], sessionFile: '' } } },
    { expanded: false, isPartial: true }, theme)), /worker running · \ds · 2 requests · 1 tool call\n\s*› bash ls/);
  const long = Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\n');
  const final = { content: [{ type: 'text', text: `${long}\n\nWorker session: /w.jsonl` }],
    details: { status: 'completed', elapsedMs: 3000, requests: 2, tools: 1 } };
  const collapsed = plain(tool.renderResult(final, { expanded: false, isPartial: false }, theme));
  assert.match(collapsed, /^completed · 3s · 2 requests · 1 tool call\nline 0[\s\S]*line 5\n… \(expand/);
  assert.doesNotMatch(collapsed, /line 6/); assert.match(collapsed, /worker session: \/w\.jsonl$/);
  assert.match(plain(tool.renderResult(final, { expanded: true, isPartial: false }, theme)), /line 8/);
  const message = plain(extension.messageRenderers.get('delegate-result')({ customType: 'delegate-result', role: 'custom',
    content: '[/do worker result] Task: commit\n\nDone.\n\nWorker session: /w.jsonl',
    details: { task: 'commit', status: 'completed', elapsedMs: 1000, requests: 1, tools: 0 } }, { expanded: false, outputPad: 0 }, theme));
  assert.doesNotMatch(message, /\[delegate-result\]|\[\/do worker/);
  assert.match(message, /^\/do commit  completed · 1s · 1 request · 0 tool calls\n\nDone\.\n\nworker session: \/w\.jsonl$/);
});

test('budget line and wrap-up message are stated plainly', async () => {
  const { wrapUpMessage, incompleteEvidence } = await import('../extensions/lib/delegation-run.ts');
  assert.match(workerInstructions('x', 'model', [], { requests: 30, minutes: 10 }), /Budget: 30 model requests and 10 minutes/);
  assert.doesNotMatch(workerInstructions('x'), /Budget:/);
  assert.match(wrapUpMessage(3, 120), /3 request\(s\), about 2 min left/);
  const ev = incompleteEvidence(Array.from({ length: 10 }, (_, i) => `f${i}.ts`), ['edit: boom'], 'halfway', 'sid');
  assert.match(ev, /Files edited: f0.ts, .*f7.ts \(\+2\)/);
  assert.match(ev, /Tool error: edit: boom/);
  assert.match(ev, /Last worker message \(not a final report\):\nhalfway/);
  assert.match(ev, /Worker session id: sid/);
});

test('incomplete run reports files edited, tool errors, last text and leaf id', { skip: !root }, async t => {
  const model = await claudeModel();
  const f = await setup(t, [
    [{ type: 'text', text: 'Writing a.txt first.' }, ...call('write', { path: 'a.txt', content: 'one' }, 1)],
    call('edit', { path: 'a.txt', edits: [{ oldText: 'missing text', newText: 'x' }] }, 2),
  ], { model });
  const result = await f.run({ maxTurns: 2 });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /Worker incomplete: Worker stopped after 2 requests/);
  assert.match(text, /Files edited: a\.txt\n/);
  assert.match(text, /Tool error: edit: /);
  assert.match(text, /Last worker message \(not a final report\):\nWriting a\.txt first\./);
  assert.match(text, new RegExp(`Worker session id: ${result.details.sessionId}`));
  assert.deepEqual(result.details.files, ['a.txt']);
  const saved = f.n.SessionManager.open(result.details.sessionFile);
  const end = saved.getBranch().findLast(e => e.customType === 'delegate-result');
  assert.ok(end.data.workerLeafId && saved.getEntry(end.data.workerLeafId), 'leaf id resolves in the worker session');
  assert.equal(end.data.errors.length, 1);
});

test('wrap-up warning is sent once near the request cap and an obedient worker completes', { skip: !root }, async t => {
  const model = await claudeModel();
  const f = await setup(t, [
    call('write', { path: 'a.txt', content: '1' }, 1),
    call('write', { path: 'b.txt', content: '2' }, 2),
    call('write', { path: 'c.txt', content: '3' }, 3),
    [{ type: 'text', text: 'Stopping: a, b, c written; d remains.' }],
  ], { model });
  const result = await f.run({ maxTurns: 6 });
  assert.equal(result.isError, false, result.content[0].text);
  assert.equal(result.details.wrapUp, 'sent');
  const seen = f.requests.map(r => JSON.stringify(r.context.messages).includes('Budget nearly spent'));
  assert.deepEqual(seen, [false, false, false, true], 'delivered before the request after the threshold, once');
  assert.match(JSON.stringify(f.requests[0].context), /Budget: 6 model requests/);
  assert.match(result.content[0].text, /d remains/);
});

test('continued worker keeps its own transcript, gets a fresh budget and is capped', { skip: !root }, async t => {
  const model = await claudeModel();
  const f = await setup(t, [
    call('write', { path: 'a.txt', content: 'first' }, 1),
    call('write', { path: 'b.txt', content: 'second' }, 2),
    [{ type: 'text', text: 'Finished b.txt after continuing.' }],
  ], { model });
  const first = await f.run({ maxTurns: 1 });
  assert.equal(first.isError, true);
  assert.ok(first.content[0].text.includes(`Continue with: delegate({ continue: "${first.details.sessionId}" })`));
  const second = await f.run({ continueFrom: first.details.sessionFile, task: 'Now write b.txt.', maxTurns: 4 });
  assert.equal(second.isError, false, second.content[0].text);
  assert.equal(second.details.sessionFile, first.details.sessionFile, 'same session file, appended');
  assert.equal(second.details.continuation, 1);
  const ctx = JSON.stringify(f.requests[1].context.messages);
  assert.match(ctx, /a\.txt/, 'continued request carries the earlier tool call');
  assert.match(ctx, /Continuation 1 of 5 of the assignment above/);
  assert.match(ctx, /Now write b\.txt\./);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'b.txt'), 'utf8'), 'second');
  assert.match(second.content[0].text, /Finished b\.txt/);
  // Model change and wrong parent are refused before any request.
  const before = f.requests.length;
  const other = { ...f.snapshot, model: { ...f.snapshot.model, id: 'other-model' } };
  await assert.rejects(runDelegateWith(f, { snapshot: other, continueFrom: first.details.sessionFile }), /switch back to it/);
  await assert.rejects(runDelegateWith(f, { snapshot: { ...f.snapshot, sessionId: 'someone-else' }, continueFrom: first.details.sessionFile }), /different parent/);
  assert.equal(f.requests.length, before);
  // Chain cap: four more continuations allowed, then refused.
  for (let i = 0; i < 4; i++) await f.run({ continueFrom: first.details.sessionFile });
  await assert.rejects(f.run({ continueFrom: first.details.sessionFile }), /already been continued 5 times/);

  // delegate_history's reader returns only the worker's own turns, not the copied parent context.
  const { workerSpan, readSpan } = await import('../extensions/lib/delegation-history.ts');
  const span = workerSpan(first.details.sessionFile);
  assert.equal(span[0].kind, 'assignment');
  assert.ok(span.some(s => s.kind === 'continuation 1' && /Now write b\.txt/.test(s.text)));
  assert.ok(span.some(s => s.kind === 'result' && /a\.txt/.test(s.text)));
  const parentText = 'Keep proposals distinct from verified work';
  assert.ok(JSON.stringify(f.snapshot.messages).includes(parentText), 'fixture parent text present');
  assert.ok(!span.some(s => s.text.includes(parentText)), 'parent context is skipped');
  const listed = readSpan(span, { query: 'b.txt' });
  assert.ok(listed.matches >= 2);
  const full = readSpan(span, { entryId: listed.items[0].id });
  assert.equal(full.entryId, listed.items[0].id);
  assert.throws(() => readSpan(span, { entryId: 'not-here' }), /own turns/);
});

test('continued OpenAI worker keeps its own controls and cache key', { skip: !root }, async t => {
  const f = await setup(t, [
    call('write', { path: 'a.txt', content: 'first' }, 1),
    [{ type: 'text', text: 'Done after continuing.' }],
  ]);
  const first = await f.run({ maxTurns: 1 });
  assert.equal(first.isError, true);
  assert.ok(first.content[0].text.includes(`Continue with: delegate({ continue: "${first.details.sessionId}" })`));
  const saved = f.n.SessionManager.open(first.details.sessionFile).getBranch().findLast(e => e.customType === 'delegate-result');
  assert.equal(saved.data.controls.prompt_cache_key, 'parent-affinity');
  assert.equal(saved.data.controls.input, undefined, 'conversation is not duplicated into the result');
  // A parent snapshot from a later turn: the continuation must not depend on it.
  const later = { ...f.snapshot, payload: undefined };
  const second = await runDelegateWith(f, { snapshot: later, continueFrom: first.details.sessionFile, task: 'Finish.' });
  assert.equal(second.isError, false, second.content[0].text);
  const req = f.requests.at(-1);
  assert.equal(req.payload.prompt_cache_key, 'parent-affinity');
  assert.match(JSON.stringify(req.context.messages), /a\.txt/);
  // A worker saved before continuation support (no controls) is refused.
  const { continuationRefusal } = await import('../extensions/lib/delegation-run.ts');
  const entries = f.n.SessionManager.open(first.details.sessionFile).getEntries()
    .map(e => e.customType === 'delegate-result' ? { ...e, data: { ...e.data, controls: undefined } } : e);
  assert.match(continuationRefusal(entries, f.snapshot), /predates continuation support/);
});

async function runDelegateWith(f, opts) {
  return runDelegate(f.sdk, { snapshot: f.snapshot, cwd: f.cwd, task: 'x', evidenceDir: path.join(f.dir, 'evidence'),
    modelRuntime: f.runtime, ...opts });
}
