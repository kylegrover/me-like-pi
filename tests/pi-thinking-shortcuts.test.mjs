import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes, createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { piDependency } from './helpers/pi-package.mjs';

// Unit tests replace only the external capability resolver. Native coverage below
// separately loads the unmodified source with installed pi-ai and jiti.
const source = readFileSync(new URL('../extensions/pi-thinking-shortcuts.ts', import.meta.url), 'utf8');
const resolverImport = 'import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";';
assert.ok(source.includes(resolverImport));
const js = stripTypeScriptTypes(source.replace(resolverImport, 'const getSupportedThinkingLevels = model => model.levels;'));
const { default: extension } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

function harness(factory = extension) {
  let level = 'medium';
  const shortcuts = new Map(), handlers = new Map(), writes = [], notices = [], statuses = [], footerClears = [], entries = [];
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    registerShortcut: (key, options) => shortcuts.set(key, options),
    getThinkingLevel: () => level,
    setThinkingLevel: value => { level = value; writes.push(value); },
  };
  const ctx = { hasUI: true, model: { provider: 'test', id: 'model', levels: ['off', 'low', 'medium', 'high', 'xhigh'] },
    sessionManager: { getBranch: () => entries },
    ui: {
      notify: (...args) => notices.push(args),
      setStatus: (key, text) => { assert.equal(text, undefined); footerClears.push(key); },
      setWidget: (key, lines, options) => {
        if (lines !== undefined) {
          assert.ok(Array.isArray(lines));
          assert.deepEqual(options, { placement: 'aboveEditor' });
        }
        statuses.push([key, lines?.join('\n')]);
      },
    } };
  factory(pi);
  return { pi, ctx, shortcuts, writes, notices, statuses, footerClears, entries,
    emit: name => handlers.get(name)?.({}, ctx), setCurrent: value => { level = value; },
    press: key => shortcuts.get(key).handler(ctx) };
}

test('registers only two shortcuts and changes nothing at load time', () => {
  const h = harness();
  assert.deepEqual([...h.shortcuts.keys()], ['shift+up', 'shift+down']);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.notices, []);
});

test('steps both directions and does not write or wrap at either endpoint', async () => {
  const h = harness();
  await h.press('shift+up'); assert.equal(h.pi.getThinkingLevel(), 'high');
  await h.press('shift+down'); assert.equal(h.pi.getThinkingLevel(), 'medium');
  h.setCurrent('off'); await h.press('shift+down'); assert.equal(h.pi.getThinkingLevel(), 'off');
  assert.deepEqual(h.notices, []);
  h.setCurrent('xhigh'); await h.press('shift+up'); assert.equal(h.pi.getThinkingLevel(), 'xhigh');
  assert.deepEqual(h.notices, []);
  assert.equal(h.writes.length, 2);
});

test('reads current model and level each time, skips unsupported gaps, includes max', async () => {
  const h = harness();
  h.ctx.model = { levels: ['low', 'high', 'max'] }; h.setCurrent('low');
  await h.press('shift+up'); assert.equal(h.pi.getThinkingLevel(), 'high');
  await h.press('shift+up'); assert.equal(h.pi.getThinkingLevel(), 'max');
  assert.deepEqual(h.notices, []); // Successful keys update status, not transient notifications.
  h.ctx.model = { levels: ['off', 'minimal'] }; h.setCurrent('minimal');
  await h.press('shift+down'); assert.equal(h.pi.getThinkingLevel(), 'off');
});

test('missing model, fixed/empty capability list, unknown level, and no UI do not mutate state', async () => {
  for (const [model, noticeCount] of [[undefined, 1], [{ levels: [] }, 0], [{ levels: ['off'] }, 0], [{ levels: ['low', 'high'] }, 1]]) {
    const h = harness(); h.ctx.model = model;
    await h.press('shift+down'); assert.deepEqual(h.writes, []); assert.equal(h.notices.length, noticeCount);
  }
  const h = harness(); h.ctx.hasUI = false;
  await h.press('shift+up'); assert.deepEqual(h.writes, []); assert.deepEqual(h.notices, []);
});

test('unexpected native clamping warns without an automatic second mutation', async () => {
  const h = harness(); let calls = 0;
  h.pi.setThinkingLevel = () => { calls++; h.setCurrent('low'); };
  await h.press('shift+up');
  assert.equal(calls, 1);
  assert.deepEqual(h.notices.at(-1), ['Requested thinking high; Pi reports low. Check /thinking.', 'warning']);
});

test('status accumulates against last request and disappears on return to baseline', async () => {
  const h = harness(); h.emit('turn_start'); h.emit('before_provider_request');
  await h.press('shift+up'); assert.equal(h.statuses.at(-1)[1], 'Thinking: medium → high');
  await h.press('shift+up'); assert.equal(h.statuses.at(-1)[1], 'Thinking: medium → xhigh');
  await h.press('shift+down'); await h.press('shift+down');
  assert.equal(h.statuses.at(-1)[1], undefined);
  assert.equal(h.entries.length, 1); assert.deepEqual(h.notices, []);
});

test('reload clears old footer; boundary presses leave the above-editor indicator unchanged', async () => {
  const h = harness(); h.emit('session_start');
  assert.deepEqual(h.footerClears, ['pi-thinking-shortcuts']);
  h.emit('turn_start'); h.emit('before_provider_request');
  await h.press('shift+up'); await h.press('shift+up');
  const updates = h.statuses.length, writes = h.writes.length;
  await h.press('shift+up'); await h.press('shift+up');
  assert.equal(h.statuses.length, updates); assert.equal(h.writes.length, writes);
  assert.equal(h.statuses.at(-1)[1], 'Thinking: medium → xhigh');
  assert.deepEqual(h.notices, []);
  h.emit('session_shutdown'); assert.equal(h.statuses.at(-1)[1], undefined);
});

test('baseline advances only at request hook and preserves in-flight selection changes', async () => {
  const h = harness(); h.emit('turn_start'); h.emit('before_provider_request');
  await h.press('shift+up'); h.emit('turn_start');
  assert.equal(h.statuses.at(-1)[1], 'Thinking: medium → high');
  await h.press('shift+up'); h.emit('before_provider_request');
  assert.equal(h.statuses.at(-1)[1], 'Thinking: high → xhigh');
  h.emit('turn_start'); h.emit('before_provider_request');
  assert.equal(h.statuses.at(-1)[1], undefined);
  assert.equal(h.entries.length, 3);
  h.emit('turn_start'); h.emit('before_provider_request');
  assert.equal(h.entries.length, 3); // No extra marker when baseline is unchanged.
});

test('reload/tree restores only valid active-branch metadata; unknown history is not guessed', async () => {
  const h = harness(); h.emit('session_start'); await h.press('shift+up');
  assert.equal(h.statuses.at(-1)[1], undefined);
  h.entries.push({ type: 'custom', customType: 'pi-thinking-baseline', data: { provider: 'test', model: 'model', level: 'medium' } });
  h.entries.push({ type: 'custom', customType: 'pi-thinking-baseline', data: { level: 'bogus' } });
  h.emit('session_start'); assert.equal(h.statuses.at(-1)[1], 'Thinking: medium → high');
  h.ctx.sessionManager.getBranch = () => [];
  h.emit('session_tree'); assert.equal(h.statuses.at(-1)[1], undefined);
});

test('native thinking/model changes refresh status; shutdown clears it', () => {
  const h = harness(); h.emit('turn_start'); h.emit('before_provider_request');
  h.setCurrent('high'); h.emit('thinking_level_select');
  assert.equal(h.statuses.at(-1)[1], 'Thinking: medium → high');
  h.ctx.model.id = 'other'; h.emit('model_select'); assert.equal(h.statuses.at(-1)[1], undefined);
  h.ctx.model.id = 'model'; h.emit('model_select'); assert.equal(h.statuses.at(-1)[1], 'Thinking: medium → high');
  h.emit('session_shutdown'); assert.equal(h.statuses.at(-1)[1], undefined);
});

test('side requests and abandoned turn snapshots do not advance the baseline', () => {
  const h = harness(); h.emit('before_provider_request'); assert.equal(h.entries.length, 0);
  h.emit('turn_start'); h.emit('agent_settled'); h.emit('before_provider_request');
  assert.equal(h.entries.length, 0);
  h.emit('turn_start'); h.emit('session_tree'); h.emit('before_provider_request');
  assert.equal(h.entries.length, 0);
});

const root = process.env.PI_PACKAGE_ROOT;
test('native SessionManager keeps baseline marker out of model context and restores it', { skip: !root }, async () => {
  const { SessionManager } = await import(pathToFileURL(resolve(root, 'dist/core/session-manager.js')).href);
  const sm = SessionManager.inMemory(process.cwd());
  const h = harness(); h.ctx.sessionManager = sm;
  h.pi.appendEntry = (type, data) => sm.appendCustomEntry(type, data);
  h.emit('turn_start'); h.emit('before_provider_request');
  assert.equal(sm.getBranch().filter(e => e.type === 'custom').length, 1);
  assert.equal(sm.buildSessionContext().messages.length, 0);
  h.setCurrent('xhigh'); h.emit('session_start');
  assert.equal(h.statuses.at(-1)[1], 'Thinking: medium → xhigh');
});

test('native key parser distinguishes Shift arrows from plain arrows; no default action conflicts', { skip: !root }, async () => {
  const native = file => import(pathToFileURL(resolve(root, file)).href);
  const { matchesKey } = await native(piDependency(root, '@earendil-works/pi-tui', 'dist/keys.js'));
  const { KeybindingsManager } = await native('dist/core/keybindings.js');
  const esc = String.fromCharCode(27);
  for (const [key, suffix] of [['shift+up', 'A'], ['shift+down', 'B']]) {
    assert.equal(matchesKey(`${esc}[1;2${suffix}`, key), true);
    assert.equal(matchesKey(`${esc}[${suffix}`, key), false);
    for (const binding of Object.values(new KeybindingsManager().getEffectiveConfig())) {
      assert.ok(!(Array.isArray(binding) ? binding : [binding]).includes(key));
    }
  }
});
test('installed jiti and pi-ai load original source and honor native capabilities', { skip: !root }, async () => {
  const require = createRequire(resolve(root, 'package.json'));
  const { createJiti } = require('jiti');
  const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false,
    alias: { '@earendil-works/pi-ai': piDependency(root, '@earendil-works/pi-ai', 'dist/index.js') } });
  const { default: factory } = await jiti.import(resolve(process.env.PI_THINKING_ENTRY ?? 'extensions/pi-thinking-shortcuts.ts'));
  const h = harness(factory);
  h.ctx.model = { reasoning: true, thinkingLevelMap: { off: null, minimal: null, xhigh: 'xhigh', max: 'max' } };
  h.setCurrent('low'); await h.press('shift+down'); assert.equal(h.pi.getThinkingLevel(), 'low');
  assert.deepEqual(h.writes, []);
  h.setCurrent('xhigh'); await h.press('shift+up'); assert.equal(h.pi.getThinkingLevel(), 'max');
  await h.press('shift+down'); assert.equal(h.pi.getThinkingLevel(), 'xhigh');
  h.ctx.model = { reasoning: false }; h.setCurrent('off');
  const count = h.writes.length;
  await h.press('shift+up'); assert.equal(h.writes.length, count);
  h.ctx.model = { reasoning: true }; h.setCurrent('high');
  await h.press('shift+up'); assert.equal(h.pi.getThinkingLevel(), 'high');
});
