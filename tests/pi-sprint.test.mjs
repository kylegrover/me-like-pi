import assert from 'node:assert/strict';
import { test } from 'node:test';
import sprint, { parseArgs } from '../extensions/pi-sprint.ts';

function harness() {
  const handlers = new Map(), commands = new Map();
  const sent = [], metadata = [], notices = [], custom = [], compactions = [];
  let entries = [], context = [], idle = true, pending = false, session = 'session-1', aborted = 0;
  const ctx = {
    hasUI: true, model: { provider: 'test', id: 'fake' },
    isIdle: () => idle, hasPendingMessages: () => pending,
    abort: () => { aborted++; },
    compact: (options) => compactions.push(options),
    ui: { notify: (...args) => notices.push(args), setStatus() {} },
    sessionManager: {
      getSessionId: () => session,
      getBranch: () => entries,
      buildContextEntries: () => context,
    },
  };
  const pi = {
    on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    registerTool() {},
    registerCommand: (name, command) => commands.set(name, command),
    sendUserMessage: (text, options) => sent.push({ text, options }),
    sendMessage: (message) => custom.push(message),
    appendEntry: (type, data) => metadata.push({ type, data }),
  };
  sprint(pi);
  const emit = async (name, event = {}) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
  };
  const command = async (name, args = '') => commands.get(name).handler(args, ctx);
  async function start(kind = 'pivot', args = 'work on the UI') {
    await command(kind, args);
    if (sent.length) {
      await emit('input', { source: 'extension', text: sent[0].text });
      await emit('before_agent_start', { prompt: sent[0].text });
    }
  }
  function final({ stopReason = 'stop', ready = true, toolCall = false } = {}) {
    const marker = sent[0].text.match(/<!-- pi-sprint-ready:[^>]+ -->/)[0];
    const text = `## Sprint recap\nUpdated notes; checks passed. No commit.\n${ready ? marker : 'Blocked; need clarification.'}`;
    const entry = { type: 'message', id: 'recap', message: {
      role: 'assistant', stopReason, content: [{ type: 'text', text }, ...(toolCall ? [{ type: 'toolCall' }] : [])],
    } };
    entries.push(entry);
    return entry;
  }
  return { command, emit, start, final, sent, metadata, notices, custom, compactions,
    setContext: (v) => { context = v; }, setEntries: (v) => { entries = v; },
    setIdle: (v) => { idle = v; }, setPending: (v) => { pending = v; },
    setSession: (v) => { session = v; }, aborted: () => aborted };
}

test('argument grammar: explicit commits, literal delimiter, missing topic, unknown flags', () => {
  assert.deepEqual(parseArgs('closeout', ''), { commit: false, topic: '' });
  assert.deepEqual(parseArgs('pivot', '--commit work on UI'), { commit: true, topic: 'work on UI' });
  assert.deepEqual(parseArgs('closeout', 'commit note'), { commit: true, topic: 'note' });
  assert.deepEqual(parseArgs('pivot', '-- commit message UI'), { commit: false, topic: 'commit message UI' });
  assert.deepEqual(parseArgs('pivot', 'explain commits'), { commit: false, topic: 'explain commits' });
  assert.throws(() => parseArgs('pivot', '--commit'), /Usage/);
  assert.throws(() => parseArgs('pivot', '--unknown UI'), /Unknown/);
});

test('pivot: wrap -> settled -> compact -> preserve -> literal next topic exactly once', async () => {
  const h = harness(); await h.start('pivot', '/some-topic with $ARGUMENTS');
  assert.match(h.sent[0].text, /Do NOT commit/);
  const recap = h.final();
  await h.emit('agent_end'); assert.equal(h.compactions.length, 0);
  await h.emit('agent_settled'); assert.equal(h.compactions.length, 1);
  assert.equal(h.sent.length, 1);
  assert.match(h.compactions[0].customInstructions, /switch topics to: \/some-topic/);
  h.compactions[0].onComplete(); h.compactions[0].onComplete();
  assert.equal(h.custom.length, 1);
  assert.ok(h.custom[0].content.endsWith(recap.message.content[0].text));
  assert.equal(h.custom[0].details.sourceEntryId, 'recap');
  assert.deepEqual(h.sent[1], { text: '/some-topic with $ARGUMENTS', options: undefined });
  assert.equal(h.sent.length, 2);
  await h.emit('agent_settled'); assert.equal(h.compactions.length, 1);
});

test('closeout stops; retained recap is not duplicated (legacy and materialized tail)', async () => {
  for (const materialized of [false, true]) {
    const h = harness(); await h.start('closeout', '--commit prepare for senior review');
    assert.match(h.sent[0].text, /commit is explicitly requested/);
    const entry = h.final();
    h.setContext(materialized ? [{ type: 'compaction', retainedTail: [entry.message] }] : [entry]);
    await h.emit('agent_settled'); h.compactions[0].onComplete();
    assert.equal(h.custom.length, 0); assert.equal(h.sent.length, 1);
    assert.equal(h.metadata.at(-1).data.phase, 'completed');
  }
});

test('invalid or busy invocations do not send work', async () => {
  const h = harness(); await h.command('pivot'); assert.equal(h.sent.length, 0);
  h.setIdle(false); await h.command('closeout'); assert.equal(h.sent.length, 0);
  h.setIdle(true); h.setPending(true); await h.command('pivot', 'UI'); assert.equal(h.sent.length, 0);
  h.setPending(false); await h.start(); await h.command('closeout'); assert.equal(h.sent.length, 1);
});

test('aborted, errored, truncated, missing-marker, and tool-call endings never compact', async () => {
  for (const options of [{ stopReason: 'aborted' }, { stopReason: 'error' }, { stopReason: 'length' }, { ready: false }, { toolCall: true }]) {
    const h = harness(); await h.start(); h.final(options); await h.emit('agent_settled');
    assert.equal(h.compactions.length, 0); assert.equal(h.sent.length, 1);
  }
});

test('tool failure latches a stop even if the final response claims readiness', async () => {
  const h = harness(); await h.start(); await h.emit('tool_result', { isError: true });
  h.final(); await h.emit('agent_settled'); assert.equal(h.compactions.length, 0);
});

test('normal tool results and automatic compaction during wrap-up do not cancel', async () => {
  const h = harness(); await h.start(); await h.emit('tool_result', { isError: false });
  await h.emit('session_before_compact', { reason: 'threshold' });
  h.final(); await h.emit('agent_settled'); assert.equal(h.compactions.length, 1);
});

test('compaction failure, including too-small session, does not continue', async () => {
  const h = harness(); await h.start(); h.final(); await h.emit('agent_settled');
  h.compactions[0].onError(new Error('Nothing to compact (session too small)'));
  h.compactions[0].onComplete(); assert.equal(h.sent.length, 1); assert.equal(h.custom.length, 0);
});

test('stop aborts current work and suppresses late compaction callbacks', async () => {
  const h = harness(); await h.start(); h.final(); await h.emit('agent_settled');
  await h.command('sprint-stop'); assert.equal(h.aborted(), 1);
  h.compactions[0].onComplete(); assert.equal(h.sent.length, 1);
  await h.command('sprint-stop'); assert.equal(h.aborted(), 1);
});

test('external input, navigation, model changes and shutdown invalidate callbacks', async () => {
  for (const [name, event] of [
    ['input', { source: 'interactive', text: 'actually stop' }],
    ['input', { source: 'extension', text: 'another extension request' }],
    ['before_agent_start', { prompt: 'different prompt' }],
    ['session_before_tree', { preparation: {} }], ['session_before_switch', {}], ['session_before_fork', {}],
    ['model_select', {}], ['thinking_level_select', {}], ['session_shutdown', {}],
    ['session_before_compact', { reason: 'manual', customInstructions: 'unrelated' }],
  ]) {
    const h = harness(); await h.start(); h.final(); await h.emit('agent_settled');
    await h.emit(name, event); h.compactions[0].onComplete();
    assert.equal(h.sent.length, 1, name); assert.equal(h.custom.length, 0, name);
  }
});

test('own compaction hook is accepted; new pending work or missing ancestry blocks return', async () => {
  for (const change of [h => h.setPending(true), h => h.setIdle(false), h => h.setEntries([]), h => h.setSession('other')]) {
    const h = harness(); await h.start(); h.final(); await h.emit('agent_settled');
    await h.emit('session_before_compact', { reason: 'manual', customInstructions: h.compactions[0].customInstructions });
    change(h); h.compactions[0].onComplete(); assert.equal(h.sent.length, 1); assert.equal(h.custom.length, 0);
  }
});

test('stale completion cannot advance a newer workflow', async () => {
  const h = harness(); await h.start(); h.final(); await h.emit('agent_settled');
  const old = h.compactions[0]; await h.command('sprint-stop');
  await h.command('pivot', 'different topic'); old.onComplete();
  assert.equal(h.sent.length, 2); assert.equal(h.custom.length, 0);
});
