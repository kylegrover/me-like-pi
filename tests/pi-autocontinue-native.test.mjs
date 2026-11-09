import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { piDependency } from './helpers/pi-package.mjs';

// Native Pi 1.4 session with scripted model output: no auth, network or real provider.
// Checks that a usage-limit error is not auto-retried by Pi, compaction is skipped while
// limited, and the extension resumes with exactly one continue turn after the reset.
const root = process.env.PI_PACKAGE_ROOT;
const native = file => import(pathToFileURL(resolve(root, file)).href);

const js = stripTypeScriptTypes(readFileSync(new URL('../extensions/pi-autocontinue.ts', import.meta.url), 'utf8'));
const { createAutoContinue, DIAGNOSTIC, CUSTOM_TYPE } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('native session: limit hit is not retried, then one auto-continue turn succeeds', { skip: !root }, async () => {
  const [{ createAgentSession }, { SettingsManager }, { SessionManager }, { createExtensionRuntime, loadExtensionFromFactory },
    { createEventBus }, { AssistantMessageEventStream }] = await Promise.all([
    native('dist/core/sdk.js'), native('dist/core/settings-manager.js'), native('dist/core/session-manager.js'),
    native('dist/core/extensions/loader.js'), native('dist/core/event-bus.js'),
    import(pathToFileURL(piDependency(root, '@earendil-works/pi-ai', 'dist/utils/event-stream.js')).href)]);

  let now = Date.now();
  const timers = [];
  const clock = { now: () => now, setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; }, setInterval: () => 0, clearInterval: () => {} };
  const resetsAt = Math.round(now / 1000) + 10 * 60;

  const model = { id: 'claude-opus-5-5', name: 'Opus', api: 'claude-code-stream-json', provider: 'claude-code', reasoning: true,
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8000 };
  const usage = (input = 0) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const base = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: now };
  const replies = [
    { ...base, content: [{ type: 'text', text: 'Working on it.' }], stopReason: 'stop', usage: usage(10) },
    { ...base, content: [], stopReason: 'error', usage: usage(),
      errorMessage: 'Claude plan usage limit reached (5-hour); resets 5:16 AM (in 10 min).',
      diagnostics: [{ type: DIAGNOSTIC, timestamp: 0, details: { resetsAt, limitType: 'five_hour', source: 'headers' } }] },
    { ...base, content: [{ type: 'text', text: 'Resumed and finished.' }], stopReason: 'stop', usage: usage(10) },
  ];
  const requests = [];
  const runtime = { getModel: () => model, getPhysicalModel: () => model, hasConfiguredAuth: () => true, isUsingOAuth: () => true,
    getAvailableSnapshot: () => [model],
    async streamSimple(_m, context) {
      requests.push(context.messages.map(m => m.role === 'custom' || m.role === 'user' ? (typeof m.content === 'string' ? m.content : m.content?.[0]?.text) : m.role));
      const reply = replies.shift();
      assert.ok(reply, 'unexpected extra model request (retry or duplicate continue)');
      const stream = new AssistantMessageEventStream();
      stream.push(reply.stopReason === 'error' ? { type: 'error', reason: 'error', error: reply } : { type: 'done', reason: 'stop', message: reply });
      stream.end();
      return stream;
    } };

  const extRuntime = createExtensionRuntime();
  const extension = await loadExtensionFromFactory(createAutoContinue(clock, 'cache'), process.cwd(), createEventBus(), extRuntime, '<autocontinue>');
  const resourceLoader = {
    getExtensions: () => ({ extensions: [extension], errors: [], runtime: extRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
  const { session } = await createAgentSession({ cwd: process.cwd(), model, thinkingLevel: 'medium', modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(process.cwd()), resourceLoader, tools: [],
    // Retries ON: proves Pi itself does not retry the usage-limit error.
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 }, cacheWarming: 'off' }) });
  await session.bindExtensions?.({});

  await session.prompt('Start the task.');
  await session.prompt('Keep going.');
  assert.equal(requests.length, 2, 'limit hit made exactly one request, no automatic retry');
  const last = session.messages.at(-1);
  assert.equal(last.stopReason, 'error');
  assert.match(last.errorMessage, /usage limit reached/);

  const armed = timers.filter(t => t.fn);
  assert.equal(armed.length, 1, 'one resume timer armed');
  now = armed[0].at;
  armed[0].fn();
  await session.agent.waitForIdle?.();
  for (let i = 0; i < 50 && requests.length < 3; i++) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 20));

  assert.equal(requests.length, 3, 'exactly one continue turn');
  assert.match(requests[2].at(-1), /usage limit has reset. Continue the task/);
  assert.equal(session.messages.at(-1).content[0].text, 'Resumed and finished.');
  const entries = session.sessionManager.getEntries();
  assert.ok(entries.some(e => e.type === 'custom' && e.customType === CUSTOM_TYPE && e.data.resetsAt === resetsAt));
  session.dispose();
});
