import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

// The extension has only type imports, so the stripped source runs as-is.
const source = readFileSync(new URL('../extensions/pi-autocontinue.ts', import.meta.url), 'utf8');
const js = stripTypeScriptTypes(source);
const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const { createAutoContinue, usageLimitOf, DIAGNOSTIC, CUSTOM_TYPE, RESUME_DELAY_MS } = mod;

const T0 = Date.UTC(2026, 10, 2, 5, 0, 0);
const sec = ms => Math.round(ms / 1000);

function fakeClock(start = T0) {
  let now = start, nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: () => 'tick', clearInterval: () => {},
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
    pending: () => timers.size,
  };
}

const limitMsg = (resetsAt, extra = {}) => ({ role: 'assistant', provider: 'claude-code', model: 'claude-opus-5-5', stopReason: 'error',
  errorMessage: 'Claude plan usage limit reached (5-hour); resets 5:16 AM (in 16 min).', timestamp: T0,
  diagnostics: [{ type: DIAGNOSTIC, timestamp: T0, details: { resetsAt, limitType: 'five_hour', source: 'headers' } }], ...extra });
const okMsg = (ts = T0) => ({ role: 'assistant', provider: 'claude-code', model: 'claude-opus-5-5', stopReason: 'stop', timestamp: ts, content: [] });

function harness({ mode = 'cache', clock = fakeClock(), branch = [] } = {}) {
  const handlers = new Map(), commands = new Map(), sent = [], entries = [], notices = [], widgets = [], keyHandlers = new Set();
  const pi = {
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: (name, opts) => commands.set(name, opts),
    sendMessage: (msg, opts) => sent.push({ msg, opts }),
    appendEntry: (type, data) => entries.push({ type, data }),
  };
  let idle = true, pending = false;
  const ctx = {
    hasUI: true, model: { provider: 'claude-code', id: 'claude-opus-5-5' },
    isIdle: () => idle, hasPendingMessages: () => pending,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (text, level) => notices.push(text),
      setWidget: (key, lines) => widgets.push(lines?.join('\n')),
      onTerminalInput: fn => { keyHandlers.add(fn); return () => keyHandlers.delete(fn); },
    },
  };
  createAutoContinue(clock, mode)(pi);
  const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
  return { pi, ctx, clock, sent, entries, notices, widgets, branch, keyHandlers, emit, commands,
    setIdle: v => { idle = v; }, setPending: v => { pending = v; },
    hit(resetsAt) { const m = limitMsg(resetsAt); branch.push({ type: 'message', message: m }); emit('message_end', { message: m }); emit('agent_settled', { aborted: false }); },
    ok(ts) { const m = okMsg(ts ?? clock.now()); branch.push({ type: 'message', message: m }); emit('message_end', { message: m }); },
    press: data => [...keyHandlers].forEach(fn => fn(data)),
    command: (args) => commands.get('autocontinue').handler(args, ctx) };
}

test('reads the adapter diagnostic and ignores ordinary errors', () => {
  assert.equal(usageLimitOf(limitMsg(123)).resetsAt, 123);
  assert.equal(usageLimitOf({ ...okMsg(), stopReason: 'error', errorMessage: 'Overloaded' }), undefined);
  assert.equal(usageLimitOf(okMsg()), undefined);
  assert.equal(usageLimitOf({ ...limitMsg(123), stopReason: 'aborted' }), undefined);
});

test('waits for the reset inside the cache window, shows a countdown, then sends one continue turn', () => {
  const h = harness();
  h.ok(T0 - 5 * 60_000);
  const resetsAt = sec(T0 + 16 * 60_000);
  h.hit(resetsAt);
  assert.match(h.widgets.at(-1), /auto-continue at .* \(in 16:20\)\. Esc or type to cancel\./);
  h.clock.advance(16 * 60_000);
  assert.equal(h.sent.length, 0, 'not before reset + delay');
  h.clock.advance(RESUME_DELAY_MS);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].msg.customType, CUSTOM_TYPE);
  assert.deepEqual(h.sent[0].opts, { triggerTurn: true });
  assert.equal(h.entries[0].data.resetsAt, resetsAt);
  assert.equal(h.widgets.at(-1), undefined, 'countdown cleared');
});

test('does not wait past the cache window unless mode is always', () => {
  const h = harness();
  h.ok(T0 - 50 * 60_000);
  h.hit(sec(T0 + 16 * 60_000));
  assert.match(h.notices.at(-1), /Not auto-continuing: reset is past the ~1 h prompt-cache window/);
  assert.equal(h.clock.pending(), 0);

  const a = harness({ mode: 'always' });
  a.ok(T0 - 50 * 60_000);
  a.hit(sec(T0 + 3 * 3600_000));
  a.clock.advance(3 * 3600_000 + RESUME_DELAY_MS);
  assert.equal(a.sent.length, 1);
});

test('Esc, typing, model switch and /autocontinue off all cancel', () => {
  for (const cancel of [h => h.press('\u001b'), h => h.emit('input', { text: 'hi' }),
    h => { h.ctx.model = { provider: 'openai-codex', id: 'gpt' }; h.emit('model_select', {}); }, h => h.command('off')]) {
    const h = harness();
    h.hit(sec(T0 + 10 * 60_000));
    assert.equal(h.clock.pending(), 1);
    cancel(h);
    assert.equal(h.clock.pending(), 0);
    assert.match(h.notices.at(-1), /Auto-continue( cancelled|: off)/);
    h.clock.advance(20 * 60_000);
    assert.equal(h.sent.length, 0);
  }
  const h = harness();
  h.hit(sec(T0 + 10 * 60_000));
  h.press('x');
  assert.equal(h.clock.pending(), 1, 'other keys do not cancel');
});

test('does not fire into a busy session and stops after two attempts for the same reset', () => {
  const busy = harness();
  busy.hit(sec(T0 + 60_000));
  busy.setIdle(false);
  busy.clock.advance(2 * 60_000);
  assert.equal(busy.sent.length, 0);

  const h = harness();
  const resetsAt = sec(T0 + 60_000);
  h.hit(resetsAt); h.clock.advance(2 * 60_000); assert.equal(h.sent.length, 1);
  h.hit(resetsAt); h.clock.advance(2 * 60_000); assert.equal(h.sent.length, 2);
  h.hit(resetsAt); h.clock.advance(2 * 60_000); assert.equal(h.sent.length, 2);
  assert.match(h.notices.at(-1), /already resumed for this reset/);
});

test('skips compaction only while limited', () => {
  const h = harness();
  assert.equal(h.emit('session_before_compact'), undefined);
  h.hit(sec(T0 + 10 * 60_000));
  assert.deepEqual(h.emit('session_before_compact'), { cancel: true });
  h.clock.advance(11 * 60_000);
  assert.equal(h.emit('session_before_compact'), undefined);
});

test('implausible timestamps fall back to now', () => {
  const h = harness();
  h.ok(0);
  h.hit(sec(T0 + 16 * 60_000));
  assert.equal(h.clock.pending(), 1, 'timestamp 0 does not count as an hour-old success');
});

test('a limit with no reset time skips compaction until the next success, without auto-continue', () => {
  const h = harness();
  const m = { ...limitMsg(0), diagnostics: [{ type: DIAGNOSTIC, timestamp: T0, details: { source: 'headers' } }] };
  h.emit('message_end', { message: m });
  h.branch.push({ type: 'message', message: m });
  h.emit('agent_settled', { aborted: false });
  assert.equal(h.clock.pending(), 0);
  assert.deepEqual(h.emit('session_before_compact'), { cancel: true });
  h.ok();
  assert.equal(h.emit('session_before_compact'), undefined);
});

test('aborted runs and a later success leave nothing armed', () => {
  const h = harness();
  const m = limitMsg(sec(T0 + 10 * 60_000));
  h.branch.push({ type: 'message', message: m });
  h.emit('message_end', { message: m });
  h.emit('agent_settled', { aborted: true });
  assert.equal(h.clock.pending(), 0);
});

test('re-arms after /reload when the branch still ends on a limit hit', () => {
  const clock = fakeClock();
  const branch = [{ type: 'message', message: okMsg(T0 - 60_000) }, { type: 'message', message: limitMsg(sec(T0 + 5 * 60_000)) }];
  const h = harness({ clock, branch });
  h.emit('session_start', {});
  assert.equal(h.clock.pending(), 1);
  h.clock.advance(6 * 60_000);
  assert.equal(h.sent.length, 1);
});

test('/autocontinue status and modes', async () => {
  const h = harness();
  await h.command('');
  assert.match(h.notices.at(-1), /Auto-continue: on \(within cache window\)\./);
  await h.command('always');
  assert.match(h.notices.at(-1), /Auto-continue: always/);
  h.hit(sec(T0 + 10 * 60_000));
  await h.command('status');
  assert.match(h.notices.at(-1), /waiting until/);
  await h.command('cancel');
  assert.equal(h.clock.pending(), 0);
});
