// Offline tests for skills/agent-chrome: fake CDP transport, no Chrome, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpClient } from '../skills/agent-chrome/scripts/lib/cdp.mjs';
import { keyEvents, MOD } from '../skills/agent-chrome/scripts/lib/keys.mjs';
import { assertLoopback, chromeArgs, paths, port, readActivePort, sessionName, findChrome } from '../skills/agent-chrome/scripts/lib/config.mjs';
import { Browser, BrowserError, runtimeValue, parseModifiers } from '../skills/agent-chrome/scripts/lib/browser.mjs';
import { SNAPSHOT_FN, LOCATE_FN, ELEMENT_FN, FOCUS_FN, NOTIFY_INPUT_FN, TEXT_FN, formatSnapshot } from '../skills/agent-chrome/scripts/lib/page-scripts.mjs';
import { fileStore } from '../skills/agent-chrome/scripts/lib/connect.mjs';
import { parseArgs, runSnippet } from '../skills/agent-chrome/scripts/agent-chrome.mjs';

const skillDir = join(dirname(fileURLToPath(import.meta.url)), '../skills/agent-chrome');

/** Fake Chrome: answers CDP calls through a handler, records what was sent, can emit events. */
function fakeChrome(handler) {
  const sent = [];
  let deliver = () => {}, fail = () => {};
  const transport = {
    send(text) {
      const msg = JSON.parse(text);
      sent.push(msg);
      queueMicrotask(async () => {
        try {
          const result = await handler(msg, sent);
          if (result === undefined) return; // simulate no reply
          deliver(JSON.stringify(result instanceof Error ? { id: msg.id, error: { message: result.message } } : { id: msg.id, result }));
        } catch (err) { deliver(JSON.stringify({ id: msg.id, error: { message: err.message } })); }
      });
    },
    close() {},
    onMessage(cb) { deliver = cb; },
    onClose(cb) { fail = cb; },
  };
  return { transport, sent, emit: (m) => deliver(JSON.stringify(m)), drop: (e) => fail(e) };
}

function memoryStore(initial = {}) { let s = initial; return { load: () => s, save: (v) => { s = v; }, get: () => s }; }

/** A small Chrome model: pages, sessions, a JS evaluator hook. */
function chromeModel({ pages = [], evaluate = () => ({ result: { value: null } }) } = {}) {
  const state = { pages: pages.map((p) => ({ type: 'page', ...p })), next: 1, attached: new Map(), closed: [], activated: [] };
  const handler = (msg) => {
    switch (msg.method) {
      case 'Target.getTargets': return { targetInfos: state.pages };
      case 'Target.createTarget': { const id = `NEW${state.next++}`; state.pages.push({ type: 'page', targetId: id, url: msg.params.url, title: '' }); return { targetId: id }; }
      case 'Target.attachToTarget': { const sid = `S-${msg.params.targetId}`; state.attached.set(sid, msg.params.targetId); return { sessionId: sid }; }
      case 'Target.detachFromTarget': return {};
      case 'Target.closeTarget': state.closed.push(msg.params.targetId); state.pages = state.pages.filter((p) => p.targetId !== msg.params.targetId); return { success: true };
      case 'Target.activateTarget': state.activated.push(msg.params.targetId); return {};
      case 'Runtime.evaluate': return evaluate(msg.params.expression, msg);
      case 'Browser.getVersion': return { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' };
      default: return {};
    }
  };
  return { state, handler };
}

// ---------- CDP client ----------
test('CDP client matches replies by id, rejects errors, buffers events, times out', async () => {
  const chrome = fakeChrome((msg) => msg.method === 'Bad.method' ? new Error('nope') : msg.method === 'Slow.method' ? undefined : { echo: msg.params });
  const cdp = new CdpClient(chrome.transport, { timeoutMs: 50 });
  assert.deepEqual(await cdp.send('X.y', { a: 1 }, 'S1'), { echo: { a: 1 } });
  assert.equal(chrome.sent[0].sessionId, 'S1');
  await assert.rejects(cdp.send('Bad.method'), /Bad.method: nope/);
  await assert.rejects(cdp.send('Slow.method'), /timed out/);
  chrome.emit({ method: 'Network.requestWillBeSent', params: { requestId: 1 }, sessionId: 'S1' });
  chrome.emit({ method: 'Page.loadEventFired', params: {}, sessionId: 'S2' });
  assert.equal(cdp.drain('S1').length, 1);
  assert.equal(cdp.drain().length, 1);
});

test('CDP client fails pending calls when Chrome disconnects', async () => {
  const chrome = fakeChrome(() => undefined);
  const cdp = new CdpClient(chrome.transport, { timeoutMs: 5000 });
  const pending = cdp.send('Page.navigate', { url: 'x' });
  chrome.drop(new Error('Chrome closed the DevTools connection'));
  await assert.rejects(pending, /closed/);
  await assert.rejects(cdp.send('Anything'), /closed/);
});

// ---------- keys ----------
test('key events match a US keyboard', () => {
  const upper = keyEvents('A');
  assert.deepEqual(upper.map((e) => e.type), ['keyDown', 'char', 'keyUp']);
  assert.equal(upper[0].code, 'KeyA');
  assert.equal(upper[0].modifiers, MOD.shift);
  assert.equal(keyEvents('!')[0].code, 'Digit1');
  assert.equal(keyEvents('!')[0].modifiers, MOD.shift);
  assert.equal(keyEvents(';')[0].windowsVirtualKeyCode, 186);
  const enter = keyEvents('Enter');
  assert.deepEqual(enter.map((e) => e.type), ['keyDown', 'keyUp']);
  assert.equal(enter[0].text, '\r');
  const ctrlA = keyEvents('a', MOD.ctrl);
  assert.deepEqual(ctrlA.map((e) => e.type), ['keyDown', 'keyUp'], 'shortcut emits no char event');
  assert.equal(ctrlA[0].modifiers, MOD.ctrl, 'caller modifiers win over shift inference');
  const accented = keyEvents('é');
  assert.equal(accented[1].text, 'é');
  assert.equal(accented[0].windowsVirtualKeyCode, 0);
  assert.equal(parseModifiers(['ctrl', 'shift']), MOD.ctrl | MOD.shift);
  assert.throws(() => parseModifiers(['hyper']), /Unknown modifier/);
});

// ---------- config: local-only, dedicated profile ----------
test('config keeps to a dedicated profile and loopback endpoints', () => {
  const p = paths({ LOCALAPPDATA: 'C:/Users/u/AppData/Local' }, 'win32');
  assert.match(p.profile.replaceAll('\\', '/'), /AppData\/Local\/agent-chrome\/profile$/);
  assert.doesNotMatch(p.profile, /Google[\\/]Chrome[\\/]User Data/);
  assert.equal(paths({ AGENT_CHROME_HOME: '/x' }, 'linux').profile.replaceAll('\\', '/'), '/x/profile');
  assert.equal(port({}), 9333);
  assert.throws(() => port({ AGENT_CHROME_PORT: '80' }), /1024-65535/);
  assert.equal(sessionName(undefined), 'default');
  assert.throws(() => sessionName('../evil'), /Invalid session/);
  assert.deepEqual(chromeArgs('/prof', 9333).slice(0, 2), ['--remote-debugging-port=9333', '--user-data-dir=/prof']);
  assert.ok(!chromeArgs('/prof', 9333).some((a) => a.includes('remote-debugging-address')), 'never binds beyond loopback');
  assert.equal(assertLoopback('ws://127.0.0.1:9333/devtools/browser/x'), 'ws://127.0.0.1:9333/devtools/browser/x');
  assert.throws(() => assertLoopback('wss://connect.browser-use.com/x'), /non-local/);
  assert.throws(() => assertLoopback('ws://192.168.1.5:9222/x'), /non-local/);
  assert.equal(findChrome({ AGENT_CHROME_BIN: '/opt/chrome' }, 'linux', () => true), '/opt/chrome');
  assert.throws(() => findChrome({}, 'linux', () => false), /AGENT_CHROME_BIN/);
});

test('DevToolsActivePort is read only from the agent profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-chrome-'));
  assert.equal(readActivePort(dir), null);
  writeFileSync(join(dir, 'DevToolsActivePort'), '9333\n/devtools/browser/abc\n');
  assert.deepEqual(readActivePort(dir), { port: 9333, url: 'ws://127.0.0.1:9333/devtools/browser/abc' });
  writeFileSync(join(dir, 'DevToolsActivePort'), 'garbage');
  assert.equal(readActivePort(dir), null);
});

// ---------- browser: tab ownership ----------
test('open() creates an owned background tab; cleanup closes only owned tabs', async () => {
  const model = chromeModel({ pages: [{ targetId: 'USER1', url: 'https://mail.example', title: 'Mail' }],
    evaluate: (expr) => ({ result: { value: expr === 'document.readyState' ? 'complete' : JSON.stringify({ url: 'u', title: 't' }) } }) });
  const store = memoryStore();
  const b = new Browser(new CdpClient(fakeChrome(model.handler).transport), store, { shotsDir: tmpdir() });
  const id = await b.open('https://example.com');
  assert.equal(store.get().current, id);
  assert.deepEqual(store.get().owned, [id]);
  await b.use(1); // the user's tab, by index
  assert.equal(store.get().current, 'USER1');
  assert.deepEqual(store.get().owned, [id], 'using a tab does not take ownership');
  const closed = await b.cleanup();
  assert.deepEqual(closed, [id]);
  assert.deepEqual(model.state.closed, [id], 'user tab left open');
  assert.deepEqual(store.get(), { current: undefined, owned: [] });
});

test('state survives across CLI calls and prunes tabs the user closed', async () => {
  const model = chromeModel({ pages: [{ targetId: 'A', url: 'x' }, { targetId: 'B', url: 'y' }] });
  const store = memoryStore({ current: 'GONE', owned: ['GONE', 'B'] });
  const b = new Browser(new CdpClient(fakeChrome(model.handler).transport), store, { shotsDir: tmpdir() });
  await assert.rejects(b.info(), /no current tab/);
  assert.deepEqual(store.get(), { current: undefined, owned: ['B'] });
  const tabs = await b.tabs();
  assert.deepEqual(tabs.map((t) => [t.id, t.owned]), [['A', false], ['B', true]]);
});

test('sessions are isolated by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-chrome-state-'));
  const a = fileStore(dir, 'alpha'), b = fileStore(dir, 'beta');
  a.save({ current: 'T1', owned: ['T1'] });
  assert.deepEqual(a.load(), { current: 'T1', owned: ['T1'] });
  assert.deepEqual(b.load(), {});
  assert.deepEqual(readdirSync(dir).sort(), ['session-alpha.json']);
});

test('release() hands tabs to the user without closing them', async () => {
  const model = chromeModel({ pages: [{ targetId: 'T', url: 'x' }] });
  const store = memoryStore({ current: 'T', owned: ['T'] });
  const b = new Browser(new CdpClient(fakeChrome(model.handler).transport), store, { shotsDir: tmpdir() });
  assert.deepEqual(b.release(), ['T']);
  assert.deepEqual(model.state.closed, []);
  assert.deepEqual(store.get(), { current: undefined, owned: [] });
});

test('resolveTab rejects ambiguous and unknown ids; show() activates only on request', async () => {
  const model = chromeModel({ pages: [{ targetId: 'AB1', url: 'x' }, { targetId: 'AB2', url: 'y' }] });
  const b = new Browser(new CdpClient(fakeChrome(model.handler).transport), memoryStore(), { shotsDir: tmpdir() });
  await assert.rejects(b.resolveTab('AB'), /ambiguous/);
  await assert.rejects(b.resolveTab('ZZ'), /No tab with id/);
  await assert.rejects(b.resolveTab(5), /No tab #5/);
  await b.use('AB2');
  assert.deepEqual(model.state.activated, [], 'use() never steals focus');
  await b.show();
  assert.deepEqual(model.state.activated, ['AB2']);
});

// ---------- browser: page actions ----------
test('click by ref locates, refuses covered targets, and dispatches real mouse events', async () => {
  let covered = true;
  const model = chromeModel({ pages: [{ targetId: 'T', url: 'x' }], evaluate: (expr) => {
    if (expr.startsWith(`(${LOCATE_FN})`)) return { result: { value: { x: 10, y: 20, covered, coveredBy: 'div#cookie' } } };
    return { result: { value: 'complete' } };
  } });
  const chrome = fakeChrome(model.handler);
  const b = new Browser(new CdpClient(chrome.transport), memoryStore({ current: 'T', owned: [] }), { shotsDir: tmpdir() });
  await assert.rejects(b.click(3), /covered by <div#cookie>/);
  covered = false;
  assert.deepEqual(await b.click(3), { x: 10, y: 20 });
  const mouse = chrome.sent.filter((m) => m.method === 'Input.dispatchMouseEvent').map((m) => m.params.type);
  assert.deepEqual(mouse, ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.ok(chrome.sent.filter((m) => m.method === 'Input.dispatchMouseEvent').every((m) => m.sessionId === 'S-T'));
});

test('fill() focuses, selects all, types key events, and notifies frameworks', async () => {
  const model = chromeModel({ pages: [{ targetId: 'T', url: 'x' }], evaluate: () => ({ result: { value: true } }) });
  const chrome = fakeChrome(model.handler);
  const b = new Browser(new CdpClient(chrome.transport), memoryStore({ current: 'T', owned: [] }), { shotsDir: tmpdir() });
  await b.fill('#email', 'a@b');
  const evals = chrome.sent.filter((m) => m.method === 'Runtime.evaluate' && m.params.expression !== 'document.visibilityState').map((m) => m.params.expression);
  assert.ok(evals[0].startsWith(`(${FOCUS_FN})("#email")`));
  assert.ok(evals.at(-1).startsWith(`(${NOTIFY_INPUT_FN})("#email")`));
  const keys = chrome.sent.filter((m) => m.method === 'Input.dispatchKeyEvent');
  assert.deepEqual(keys[0].params.commands, ['SelectAll']);
  assert.equal(keys[0].params.modifiers, MOD.ctrl, 'Windows user agent selects all with Ctrl');
  const typed = keys.filter((k) => k.params.type === 'char').map((k) => k.params.text).join('');
  assert.equal(typed, 'a@b');
});

test('js() retries top-level return in a function and reports page errors clearly', async () => {
  const model = chromeModel({ pages: [{ targetId: 'T', url: 'x' }], evaluate: (expr) => {
    if (expr === 'return 1') return { result: { subtype: 'error', description: 'SyntaxError: Illegal return statement' }, exceptionDetails: { text: 'Uncaught' } };
    if (expr.includes('return 1')) return { result: { value: 1 } };
    if (expr === 'boom()') return { result: { subtype: 'error', description: 'ReferenceError: boom is not defined\n    at <anonymous>' }, exceptionDetails: {} };
    return { result: { value: null } };
  } });
  const b = new Browser(new CdpClient(fakeChrome(model.handler).transport), memoryStore({ current: 'T', owned: [] }), { shotsDir: tmpdir() });
  assert.equal(await b.js('return 1'), 1);
  await assert.rejects(b.js('boom()'), /JavaScript error: ReferenceError: boom is not defined \(in: boom\(\)\)/);
  assert.ok(Number.isNaN(runtimeValue({ result: { unserializableValue: 'NaN' } }, 'x')));
  assert.equal(runtimeValue({ result: { unserializableValue: '10n' } }, 'x'), 10n);
});

test('open dialogs are surfaced instead of hanging', async () => {
  const model = chromeModel({ pages: [{ targetId: 'T', url: 'x' }], evaluate: () => undefined });
  const chrome = fakeChrome(model.handler);
  const cdp = new CdpClient(chrome.transport, { timeoutMs: 50 });
  const b = new Browser(cdp, memoryStore({ current: 'T', owned: [] }), { shotsDir: tmpdir() });
  await b.raw('Page.enable');
  chrome.emit({ method: 'Page.javascriptDialogOpening', params: { type: 'confirm', message: 'Leave?' }, sessionId: 'S-T' });
  assert.deepEqual(await b.info(), { dialog: { type: 'confirm', message: 'Leave?' } });
  await assert.rejects(b.evaluate('1'), /confirm dialog is open/);
  await b.dialog(true);
  assert.ok(chrome.sent.some((m) => m.method === 'Page.handleJavaScriptDialog' && m.params.accept === true));
});

test('screenshot writes the decoded PNG under the shots dir and caps size', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const model = chromeModel({ pages: [{ targetId: 'T', url: 'x' }], evaluate: () => ({ result: { value: JSON.stringify({ w: 2000, h: 1000, pw: 2000, ph: 5000, dpr: 2 }) } }) });
  const base = model.handler;
  const chrome = fakeChrome((m) => m.method === 'Page.captureScreenshot' ? { data: png.toString('base64') } : base(m));
  const dir = mkdtempSync(join(tmpdir(), 'agent-chrome-shots-'));
  const b = new Browser(new CdpClient(chrome.transport), memoryStore({ current: 'T', owned: [] }), { shotsDir: dir, now: () => 42 });
  const out = await b.screenshot();
  assert.equal(out, join(dir, 'shot-42.png'));
  assert.deepEqual(readFileSync(out), png);
  const shot = chrome.sent.find((m) => m.method === 'Page.captureScreenshot');
  assert.equal(shot.params.clip.scale, 0.4, '2000px CSS at 2x DPR capped to 1600px');
});

test('waitForIdle tracks only the current tab', async () => {
  let t = 0;
  const model = chromeModel({ pages: [{ targetId: 'T', url: 'x' }] });
  const chrome = fakeChrome(model.handler);
  const b = new Browser(new CdpClient(chrome.transport), memoryStore({ current: 'T', owned: [] }), { shotsDir: tmpdir(), now: () => t });
  const done = b.waitForIdle({ timeout: 5, idle: 500 });
  await new Promise((r) => setTimeout(r, 20));
  chrome.emit({ method: 'Network.requestWillBeSent', params: { requestId: 'other' }, sessionId: 'S-OTHER' });
  chrome.emit({ method: 'Network.requestWillBeSent', params: { requestId: 'r1' }, sessionId: 'S-T' });
  t = 100;
  await new Promise((r) => setTimeout(r, 150));
  chrome.emit({ method: 'Network.loadingFinished', params: { requestId: 'r1' }, sessionId: 'S-T' });
  t = 700;
  assert.equal(await done, true);
});

// ---------- page scripts ----------
test('page scripts are valid JavaScript and snapshot formatting is compact', () => {
  for (const src of [SNAPSHOT_FN, LOCATE_FN, ELEMENT_FN, FOCUS_FN, NOTIFY_INPUT_FN, TEXT_FN]) {
    assert.doesNotThrow(() => new Function(`return (${src})`), src.slice(0, 40));
  }
  const text = formatSnapshot({ url: 'https://x.test/', title: 'X', viewport: { w: 800, h: 600, sx: 0, sy: 0, pw: 800, ph: 2000 },
    elements: [{ ref: 1, role: 'button', name: 'Save', inView: true }, { ref: 2, role: 'email', name: 'Email', value: '', inView: false }], omitted: 3 });
  assert.equal(text, 'X — https://x.test/\nviewport 800x600 scroll 0,0 of 800x2000\n[1] button "Save"\n[2] email "Email" value="" (offscreen)\n… 3 more elements omitted; scroll or snapshot({max}) to see more');
  assert.match(SNAPSHOT_FN, /'••••'/, 'password values are masked');
});

// ---------- CLI ----------
test('CLI parses session/timeout and runs snippets with bound helpers', async () => {
  assert.deepEqual(parseArgs(['--session', 'w1', 'tabs']).session, 'w1');
  assert.throws(() => parseArgs(['--timeout', '0']), /positive/);
  assert.throws(() => parseArgs(['--session', 'a b']), /Invalid session/);
  const logs = [];
  const fakeBrowser = { open: async (u) => `opened ${u}` };
  for (const name of ['goto', 'back', 'use', 'show', 'close', 'tabs', 'info', 'snapshot', 'text', 'js', 'frames', 'click', 'fill', 'type', 'press', 'scroll', 'upload', 'dialog', 'screenshot', 'waitForLoad', 'waitFor', 'waitForIdle', 'raw']) {
    fakeBrowser[name] = async () => name;
  }
  const out = await runSnippet(fakeBrowser, "console.log('hi', {a: 1}); return await open('https://e.test')", { log: (l) => logs.push(l) });
  assert.equal(out, 'opened https://e.test');
  assert.deepEqual(logs, ['hi { a: 1 }']);
});

// ---------- network hygiene ----------
test('source contains no telemetry, cloud, update or non-loopback network code', () => {
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(join(d, f.name)) : f.name.endsWith('.mjs') && files.push(join(d, f.name)); };
  walk(join(skillDir, 'scripts'));
  assert.ok(files.length >= 6);
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /posthog|telemetry\s*\(|browser-use\.com|pypi\.org|npmjs|analytics|sentry/i, f);
    for (const [, url] of src.matchAll(/(?:https?|wss?):\/\/([^/'"`\s$]+)/g)) {
      assert.ok(/^(127\.0\.0\.1|localhost)(:|$)/.test(url) || /\.test$|^example\.com$/.test(url), `${f}: unexpected host ${url}`);
    }
    assert.doesNotMatch(src, /\bimport\s.*from\s+['"](?!node:|\.)/, `${f}: third-party import`);
  }
});

test('skill frontmatter follows the Agent Skills format', () => {
  const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  const front = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  assert.match(front, /^name: agent-chrome$/m);
  const description = front.match(/^description: (.*)$/m)?.[1] ?? '';
  assert.ok(description.length > 40 && description.length <= 1024);
  assert.ok(existsSync(join(skillDir, 'NOTICE')));
});

// ---------- regressions found in the 2026-11-01 live trial (Chrome 156, Windows) ----------
import { endpoint, readRecord } from '../skills/agent-chrome/scripts/lib/connect.mjs';

const jsonVersion = (path) => async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:9333${path}` }) });

test('endpoint accepts the recorded launched browser when Chrome writes no DevToolsActivePort', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-chrome-ep-'));
  const p = { profile: join(home, 'profile'), state: join(home, 'state') };
  mkdirSync(p.state, { recursive: true });
  assert.equal(await endpoint({ p, debugPort: 9333, fetchImpl: jsonVersion('/devtools/browser/ours') }), null, 'unknown browser rejected');
  writeFileSync(join(p.state, 'browser.json'), JSON.stringify({ port: 9333, browserPath: '/devtools/browser/ours' }));
  assert.equal(readRecord(p).browserPath, '/devtools/browser/ours');
  assert.equal(await endpoint({ p, debugPort: 9333, fetchImpl: jsonVersion('/devtools/browser/ours') }), 'ws://127.0.0.1:9333/devtools/browser/ours');
  assert.equal(await endpoint({ p, debugPort: 9333, fetchImpl: jsonVersion('/devtools/browser/other') }), null, 'a different browser on the port is refused');
  await assert.rejects(endpoint({ p, debugPort: 9333, fetchImpl: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://10.0.0.2:9333/devtools/browser/ours' }) }) }), /non-local/);
});

test('input actions foreground a hidden tab first; reads do not', async () => {
  let visibility = 'hidden';
  const model = chromeModel({ pages: [{ targetId: 'T', url: 'x' }], evaluate: (expr) => {
    if (expr === 'document.visibilityState') return { result: { value: visibility } };
    if (expr.startsWith(`(${LOCATE_FN})`)) return { result: { value: { x: 1, y: 2, covered: false } } };
    return { result: { value: 'complete' } };
  } });
  const base = model.handler;
  const chrome = fakeChrome((m) => { if (m.method === 'Target.activateTarget') visibility = 'visible'; return base(m); });
  const b = new Browser(new CdpClient(chrome.transport), memoryStore({ current: 'T', owned: [] }), { shotsDir: tmpdir() });
  await b.text();
  assert.deepEqual(model.state.activated, [], 'reading leaves the tab in the background');
  await b.click(1);
  assert.deepEqual(model.state.activated, ['T']);
  const order = chrome.sent.map((m) => m.method);
  assert.ok(order.indexOf('Target.activateTarget') < order.indexOf('Input.dispatchMouseEvent'));
  await b.press('Enter');
  assert.deepEqual(model.state.activated, ['T'], 'already visible: no second activation');
});
