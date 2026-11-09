// Browser operations for one agent session inside the dedicated agent Chrome.
// Behavior follows browser-use/browser-harness helpers.py (MIT, see ../../NOTICE), re-designed
// daemonless: each CLI call connects to Chrome's loopback DevTools socket, does its work, detaches.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { keyEvents, MOD } from './keys.mjs';
import { SNAPSHOT_FN, LOCATE_FN, ELEMENT_FN, FOCUS_FN, NOTIFY_INPUT_FN, TEXT_FN, PAGE_INFO_EXPR, formatSnapshot } from './page-scripts.mjs';

export const INTERNAL = ['chrome://', 'chrome-untrusted://', 'devtools://', 'chrome-extension://', 'about:'];
const TEXT_LIMIT = 8_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BrowserError extends Error {}

export function clip(text, limit = TEXT_LIMIT) {
  const s = String(text ?? '');
  return s.length > limit ? `${s.slice(0, limit)}\n… [${s.length - limit} more characters truncated]` : s;
}

/**
 * @param {import('./cdp.mjs').CdpClient} cdp  browser-level connection
 * @param {{load(): {current?: string, owned: string[]}, save(state): void}} store  per-session state
 */
export class Browser {
  constructor(cdp, store, { shotsDir, now = Date.now } = {}) {
    this.cdp = cdp;
    this.store = store;
    this.state = { current: undefined, owned: [], ...store.load() };
    this.state.owned = [...new Set(this.state.owned || [])];
    this.shotsDir = shotsDir;
    this.now = now;
    this.sessions = new Map(); // targetId -> CDP sessionId
    this.pendingDialog = null;
  }

  #save() { this.store.save({ current: this.state.current, owned: this.state.owned }); }

  // ---------- tabs ----------
  async targets() { return (await this.cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page'); }

  async tabs() {
    const owned = new Set(this.state.owned);
    return (await this.targets()).map((t) => ({ id: t.targetId, title: t.title, url: t.url,
      current: t.targetId === this.state.current, owned: owned.has(t.targetId) }));
  }

  async #prune() {
    const alive = new Set((await this.targets()).map((t) => t.targetId));
    const owned = this.state.owned.filter((id) => alive.has(id));
    const current = alive.has(this.state.current) ? this.state.current : undefined;
    if (owned.length !== this.state.owned.length || current !== this.state.current) {
      this.state = { current, owned };
      this.#save();
    }
    return alive;
  }

  /** Resolve a tab id, unique id prefix, or 1-based index from tabs(). */
  async resolveTab(target) {
    const pages = await this.targets();
    if (typeof target === 'number' || /^\d+$/.test(String(target))) {
      const tab = pages[Number(target) - 1];
      if (!tab) throw new BrowserError(`No tab #${target}; there are ${pages.length}.`);
      return tab.targetId;
    }
    const matches = pages.filter((t) => t.targetId === target || t.targetId.startsWith(String(target)));
    if (matches.length !== 1) throw new BrowserError(matches.length ? `Tab id ${target} is ambiguous.` : `No tab with id ${target}.`);
    return matches[0].targetId;
  }

  async #session(targetId) {
    if (this.sessions.has(targetId)) return this.sessions.get(targetId);
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessions.set(targetId, sessionId);
    const pageEvents = this.cdp.on((e) => {
      if (e.sessionId !== sessionId) return;
      if (e.method === 'Page.javascriptDialogOpening') this.pendingDialog = e.params;
      if (e.method === 'Page.javascriptDialogClosed') this.pendingDialog = null;
    });
    this.sessions.set(`${targetId}:off`, pageEvents);
    await Promise.all(['Page', 'Runtime', 'Network'].map((d) => this.cdp.send(`${d}.enable`, {}, sessionId).catch(() => {})));
    return sessionId;
  }

  async #currentSession() {
    const alive = await this.#prune();
    if (!this.state.current || !alive.has(this.state.current)) {
      throw new BrowserError('This session has no current tab. Use open(url), or tabs() then use(id).');
    }
    return this.#session(this.state.current);
  }

  #send(method, params, sessionId, opts) { return this.cdp.send(method, params, sessionId, opts); }

  /**
   * Chrome drops synthetic input to hidden tabs without any error (verified live, Chrome 156),
   * so input actions bring their tab to the front of the agent window first. Reads don't.
   */
  async #inputSession() {
    const sid = await this.#currentSession();
    const state = await this.evaluate('document.visibilityState', { sessionId: sid, timeoutMs: 5_000 }).catch(() => 'visible');
    if (state === 'hidden') {
      await this.cdp.send('Target.activateTarget', { targetId: this.state.current });
      for (let i = 0; i < 20; i++) {
        if (await this.evaluate('document.visibilityState', { sessionId: sid, timeoutMs: 5_000 }).catch(() => 'visible') !== 'hidden') break;
        await sleep(50);
      }
    }
    return sid;
  }

  /** Open a new background tab owned by this session and make it current. */
  async open(url = 'about:blank') {
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank', background: true });
    this.state.current = targetId;
    this.state.owned = [...new Set([...this.state.owned, targetId])];
    this.#save();
    if (url !== 'about:blank') await this.goto(url);
    return targetId;
  }

  /** Make an existing tab this session's current tab (without taking ownership or focus). */
  async use(target) {
    this.state.current = await this.resolveTab(target);
    this.#save();
    return this.state.current;
  }

  /** Bring the current tab to the front so the user can watch or take over. */
  async show() {
    await this.#currentSession();
    await this.cdp.send('Target.activateTarget', { targetId: this.state.current });
    return this.state.current;
  }

  async close(target) {
    const targetId = target === undefined ? this.state.current : await this.resolveTab(target);
    if (!targetId) throw new BrowserError('No tab to close.');
    await this.cdp.send('Target.closeTarget', { targetId });
    this.state.owned = this.state.owned.filter((id) => id !== targetId);
    if (this.state.current === targetId) this.state.current = undefined;
    this.#save();
    return targetId;
  }

  /** Close every tab this session opened; tabs it merely used are left alone. */
  async cleanup() {
    const alive = await this.#prune();
    const closed = [];
    for (const id of this.state.owned) {
      if (!alive.has(id)) continue;
      await this.cdp.send('Target.closeTarget', { targetId: id }).catch(() => {});
      closed.push(id);
    }
    this.state = { current: undefined, owned: [] };
    this.#save();
    return closed;
  }

  /** Stop tracking this session's tabs without closing them (hand them to the user). */
  release() {
    const released = this.state.owned;
    this.state = { current: undefined, owned: [] };
    this.#save();
    return released;
  }

  // ---------- page ----------
  async evaluate(expression, { sessionId, awaitPromise = true, timeoutMs } = {}) {
    const sid = sessionId ?? await this.#currentSession();
    let r;
    try {
      r = await this.#send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sid, { timeoutMs });
    } catch (err) {
      if (this.pendingDialog) throw new BrowserError(`A ${this.pendingDialog.type} dialog is open (${JSON.stringify(this.pendingDialog.message)}); call dialog(accept).`);
      throw err;
    }
    return runtimeValue(r, expression);
  }

  /** Call a page-side function source with JSON arguments. */
  async call(fnSource, ...args) {
    return this.evaluate(`(${fnSource})(${args.map((a) => JSON.stringify(a)).join(',')})`);
  }

  async info() {
    await this.#currentSession();
    if (this.pendingDialog) return { dialog: this.pendingDialog };
    return JSON.parse(await this.evaluate(PAGE_INFO_EXPR));
  }

  async goto(url, { timeout = 15 } = {}) {
    const sid = await this.#currentSession();
    const r = await this.#send('Page.navigate', { url }, sid);
    if (r.errorText) throw new BrowserError(`Navigation to ${url} failed: ${r.errorText}`);
    await this.waitForLoad({ timeout });
    return this.info();
  }

  async back() { await this.evaluate('history.back()'); await sleep(300); await this.waitForLoad(); return this.info(); }

  async snapshot({ max = 150 } = {}) { return formatSnapshot(await this.call(SNAPSHOT_FN, max)); }

  async text(selector, { limit = TEXT_LIMIT } = {}) { return clip(await this.call(TEXT_FN, selector ?? null), limit); }

  /** Run JavaScript in the current tab, or in an iframe target when `frame` (URL substring) is given. */
  async js(expression, { frame } = {}) {
    if (!frame) return this.#evaluateWithReturn(expression);
    const t = (await this.cdp.send('Target.getTargets')).targetInfos.find((x) => x.type === 'iframe' && x.url.includes(frame));
    if (!t) throw new BrowserError(`No iframe target whose URL contains ${JSON.stringify(frame)}.`);
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    try { return await this.#evaluateWithReturn(expression, sessionId); }
    finally { await this.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
  }

  async #evaluateWithReturn(expression, sessionId) {
    try { return await this.evaluate(expression, { sessionId }); }
    catch (err) {
      if (!/Illegal return statement/.test(err.message)) throw err;
      return this.evaluate(`(async function(){${expression}\n})()`, { sessionId });
    }
  }

  async frames() {
    return (await this.cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'iframe').map((t) => ({ id: t.targetId, url: t.url }));
  }

  // ---------- input ----------
  /** Click a snapshot ref, a CSS selector, or explicit viewport coordinates {x, y}. */
  async click(target, { button = 'left', clicks = 1 } = {}) {
    const sid = await this.#inputSession();
    let x, y;
    if (target && typeof target === 'object') ({ x, y } = target);
    else {
      const at = await this.call(LOCATE_FN, target);
      if (at.covered) {
        throw new BrowserError(`Target ${JSON.stringify(target)} is covered by <${at.coveredBy}> at ${at.x},${at.y}. ` +
          'Dismiss the overlay first, or click({x, y}) deliberately.');
      }
      ({ x, y } = at);
    }
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sid);
    await this.#send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: clicks }, sid);
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: clicks }, sid);
    await sleep(150);
    await this.waitForLoad({ timeout: 10 }).catch(() => false);
    return { x, y };
  }

  /** Insert text at the focused element (fast; bypasses key handlers). */
  async type(text) { await this.#send('Input.insertText', { text }, await this.#inputSession()); }

  async press(key, modifiers = 0) {
    const sid = await this.#inputSession();
    const mods = typeof modifiers === 'number' ? modifiers : parseModifiers(modifiers);
    for (const ev of keyEvents(key, mods)) await this.#send('Input.dispatchKeyEvent', ev, sid);
  }

  /** Fill a framework-managed input: focus, clear, real key events, then input/change events. */
  async fill(target, text, { clear = true } = {}) {
    const sid = await this.#inputSession();
    await this.call(FOCUS_FN, target);
    if (clear) {
      const ua = (await this.cdp.send('Browser.getVersion')).userAgent || '';
      const modifiers = /Mac OS X|Macintosh/.test(ua) ? MOD.meta : MOD.ctrl;
      const selectAll = { key: 'a', code: 'KeyA', modifiers, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 };
      await this.#send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...selectAll, commands: ['SelectAll'] }, sid);
      await this.#send('Input.dispatchKeyEvent', { type: 'keyUp', ...selectAll }, sid);
      await this.press('Backspace');
    }
    if (text.length > 200) await this.type(text);
    else for (const ch of text) await this.press(ch);
    await this.call(NOTIFY_INPUT_FN, target);
  }

  async scroll({ dy = 600, dx = 0, x, y } = {}) {
    const sid = await this.#inputSession();
    const v = await this.info();
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x ?? Math.round(v.w / 2), y: y ?? Math.round(v.h / 2), deltaX: dx, deltaY: dy }, sid);
    await sleep(200);
    return this.info();
  }

  async upload(target, files) {
    const sid = await this.#currentSession();
    const expression = `(${ELEMENT_FN})(${JSON.stringify(target)})`;
    const r = await this.#send('Runtime.evaluate', { expression, returnByValue: false }, sid);
    if (r.exceptionDetails || !r.result?.objectId) throw new BrowserError(`Upload target not found: ${JSON.stringify(target)}`);
    await this.#send('DOM.setFileInputFiles', { files: [].concat(files), objectId: r.result.objectId }, sid);
  }

  async dialog(accept = true, promptText) {
    const sid = await this.#currentSession();
    await this.#send('Page.handleJavaScriptDialog', { accept, ...(promptText === undefined ? {} : { promptText }) }, sid);
    this.pendingDialog = null;
  }

  // ---------- visual ----------
  /** Save a PNG of the viewport (or full page) and return its path. `max` caps the longest side in pixels. */
  async screenshot({ path, full = false, max = 1600 } = {}) {
    const sid = await this.#currentSession();
    const params = { format: 'png', captureBeyondViewport: full };
    if (max) {
      const m = await this.evaluate('JSON.stringify({w:innerWidth,h:innerHeight,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight,dpr:devicePixelRatio})').then(JSON.parse);
      const width = full ? m.pw : m.w, height = full ? m.ph : m.h;
      const scale = Math.min(1, max / (Math.max(width, height) * (m.dpr || 1)));
      if (scale < 1 || full) params.clip = { x: 0, y: 0, width, height, scale };
    }
    const { data } = await this.#send('Page.captureScreenshot', params, sid, { timeoutMs: 60_000 });
    const out = path || join(this.shotsDir, `shot-${this.now()}.png`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(data, 'base64'));
    return out;
  }

  // ---------- waiting ----------
  async waitForLoad({ timeout = 15 } = {}) {
    const deadline = this.now() + timeout * 1000;
    while (this.now() < deadline) {
      if (await this.evaluate('document.readyState', { timeoutMs: 5_000 }).catch(() => null) === 'complete') return true;
      await sleep(250);
    }
    return false;
  }

  async waitFor(selector, { timeout = 10, visible = false } = {}) {
    const q = JSON.stringify(selector);
    const check = visible
      ? `(()=>{const e=document.querySelector(${q});if(!e)return false;return typeof e.checkVisibility==='function'?e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}):getComputedStyle(e).display!=='none'})()`
      : `!!document.querySelector(${q})`;
    const deadline = this.now() + timeout * 1000;
    while (this.now() < deadline) {
      if (await this.evaluate(check)) return true;
      await sleep(250);
    }
    return false;
  }

  /** Wait until no network requests are in flight for `idle` ms (current tab only). */
  async waitForIdle({ timeout = 10, idle = 500 } = {}) {
    const sid = await this.#currentSession();
    const inflight = new Set();
    let last = this.now();
    const off = this.cdp.on((e) => {
      if (e.sessionId !== sid || !e.method.startsWith('Network.')) return;
      if (e.method === 'Network.requestWillBeSent') inflight.add(e.params.requestId);
      else if (e.method === 'Network.loadingFinished' || e.method === 'Network.loadingFailed') inflight.delete(e.params.requestId);
      last = this.now();
    });
    try {
      const deadline = this.now() + timeout * 1000;
      while (this.now() < deadline) {
        if (!inflight.size && this.now() - last >= idle) return true;
        await sleep(100);
      }
      return false;
    } finally { off(); }
  }

  /** Raw CDP on the current tab; Target.* and Browser.* go to the browser. */
  async raw(method, params = {}) {
    const browserLevel = /^(Target|Browser|SystemInfo)\./.test(method);
    return this.#send(method, params, browserLevel ? undefined : await this.#currentSession());
  }

  async detach() {
    for (const [key, value] of this.sessions) {
      if (key.endsWith(':off')) { value(); continue; }
      await this.cdp.send('Target.detachFromTarget', { sessionId: value }).catch(() => {});
    }
    this.sessions.clear();
  }
}

export function parseModifiers(list) {
  return [].concat(list || []).reduce((m, name) => {
    const bit = MOD[String(name).toLowerCase()];
    if (!bit) throw new BrowserError(`Unknown modifier ${name}; use alt, ctrl, meta, shift.`);
    return m | bit;
  }, 0);
}

export function runtimeValue(response, expression) {
  const result = response.result ?? {};
  const details = response.exceptionDetails;
  if (details || result.subtype === 'error') {
    const desc = result.description || details?.exception?.description || details?.text || 'JavaScript evaluation failed';
    const snippet = expression.replace(/\s+/g, ' ').slice(0, 120);
    throw new BrowserError(`JavaScript error: ${desc.split('\n')[0]} (in: ${snippet})`);
  }
  if ('value' in result) return result.value;
  if ('unserializableValue' in result) {
    const u = result.unserializableValue;
    return { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 }[u] ?? (u.endsWith('n') ? BigInt(u.slice(0, -1)) : u);
  }
  return undefined;
}
