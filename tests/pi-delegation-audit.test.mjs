import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createDelegateAudit } from '../extensions/lib/delegation-audit.ts';
import { auditDelegation } from '../scripts/lib/delegation-audit.mjs';

const time = '2026-10-28T20:00:00.000Z';
const usage = { input: 10, output: 2, cacheRead: 30, cacheWrite: 0, totalTokens: 42, cost: { total: 0.1 } };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-audit-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const sessionsDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsDir);
  const rows = [{ type: 'session', id: 'parent', cwd: '/PRIVATE/PROJECT' }];
  const add = (kind, data, timestamp = time) => rows.push({ type: 'custom', customType: 'delegate-audit',
    id: `entry-${rows.length}`, timestamp, data: { schemaVersion: 1, eventId: `event-${rows.length}`,
      kind, guidanceId: 'version-a', parentSessionId: 'parent', ...data } });
  const save = () => fs.writeFileSync(path.join(sessionsDir, 'parent.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
  const audit = options => { save(); return auditDelegation({ sessionsDir,
    since: Date.parse('2026-10-28'), until: Date.parse('2026-10-29'), ...options }); };
  return { dir, sessionsDir, rows, add, save, audit };
}

test('audit guidance fingerprint is stable, versions changes, and writes no model messages', () => {
  const rows = [];
  const configuration = { description: 'Public description', workerInstructions: 'Public template <task>' };
  const a = createDelegateAudit((type, data) => rows.push({ type, data }), configuration);
  const b = createDelegateAudit(() => {}, { ...configuration });
  const c = createDelegateAudit(() => {}, { ...configuration, description: 'Changed guidance' });
  assert.equal(a.guidanceId, b.guidanceId);
  assert.notEqual(a.guidanceId, c.guidanceId);
  a.record({ kind: 'request', requestId: 'r1' });
  a.record({ kind: 'response', requestId: 'r1', calls: [] });
  assert.deepEqual(rows.map(r => r.data.kind), ['configuration', 'request', 'response']);
  assert.ok(rows.every(r => r.type === 'delegate-audit' && r.data.schemaVersion === 1));
  assert.equal(new Set(rows.map(r => r.data.eventId)).size, 3);
});

test('audit persistence failure warns once without breaking worker execution', () => {
  const previous = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(message);
  try {
    const audit = createDelegateAudit(() => { throw new Error('disk failure'); },
      { description: 'd', workerInstructions: 'w' });
    assert.doesNotThrow(() => { audit.record({ kind: 'call' }); audit.record({ kind: 'outcome' }); });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /coverage may be incomplete/);
  } finally { console.warn = previous; }
});

test('reports use AND non-use, distinct user turns, unfinished calls and deduplicated metadata', async t => {
  const f = fixture(t);
  const req = id => f.add('request', { requestId: id, provider: 'openai', model: 'model-a',
    delegateActive: true, userEntryId: 'same-user-turn' });
  req('r1');
  f.add('response', { requestId: 'r1', calls: [{ id: 'c1', name: 'delegate' }], usage, stopReason: 'toolUse' });
  f.add('call', { requestId: 'r1', toolCallId: 'c1' });
  f.add('outcome', { requestId: 'r1', toolCallId: 'c1', status: 'completed', usage, elapsedMs: 125 });
  req('r2');
  f.add('response', { requestId: 'r2', calls: [{ id: 'b1', name: 'bash' }], usage, stopReason: 'toolUse' });
  req('r3');
  f.add('response', { requestId: 'r3', calls: [], usage, stopReason: 'stop' });
  req('r4'); // In flight or crashed; do not invent a choice.
  f.add('call', { requestId: 'r4', toolCallId: 'c2' });
  f.add('request', { requestId: 'inactive', delegateActive: false, provider: 'openai', model: 'model-a' });
  f.rows.push({ type: 'message', message: { role: 'user', content: 'PRIVATE USER PROMPT' } });
  const out = await f.audit();
  const group = out.groups[0];
  assert.equal(group.activeRequests, 4);
  assert.equal(group.parentRequestIntents, 5);
  assert.equal(group.responses, 3);
  assert.equal(group.delegatingResponses, 1);
  assert.equal(group.directToolResponses, 1);
  assert.equal(group.answerOnlyResponses, 1);
  assert.equal(group.unansweredRequests, 1);
  assert.equal(group.observedUserTurns, 1);
  assert.equal(group.delegationResponseFraction, 1 / 3);
  assert.deepEqual(group.outcomes, { completed: 1, unfinished: 1 });
  assert.deepEqual(group.workerUsage.input, { sum: 10, known: 1, missing: 1 });
  assert.equal(group.parentUsage.totalTokens.sum, 126);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE|parent.jsonl|same-user-turn|PRIVATE USER PROMPT/);
  fs.copyFileSync(path.join(f.sessionsDir, 'parent.jsonl'), path.join(f.sessionsDir, 'copied-branch.jsonl'));
  const copied = await f.audit();
  assert.deepEqual(copied.groups, out.groups);
  assert.ok(copied.coverage.duplicatesSkipped > 0);
});

test('worker first-call/cache telemetry excludes inherited usage and exports no transcripts', async t => {
  const f = fixture(t), workerFile = path.join(f.dir, 'worker.jsonl');
  fs.writeFileSync(workerFile, [
    { type: 'message', message: { role: 'assistant', usage: { ...usage, input: 999999 }, content: [] } },
    { type: 'custom', customType: 'delegate-origin', data: { task: 'PRIVATE TASK' } },
    { type: 'message', message: { role: 'assistant', usage: { ...usage, cacheRead: 0 },
      content: [{ type: 'toolCall', name: 'read', arguments: { path: '/PRIVATE/file' } }] } },
    { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'PRIVATE TOOL OUTPUT' }] } },
    { type: 'message', message: { role: 'assistant', usage, content: [{ type: 'text', text: 'PRIVATE RECEIPT' }] } },
  ].map(r => JSON.stringify(r)).join('\n'));
  f.add('request', { requestId: 'r1', provider: 'openai', model: 'a', delegateActive: true });
  f.add('call', { requestId: 'r1', toolCallId: 'c1' });
  f.add('outcome', { requestId: 'r1', toolCallId: 'c1', status: 'completed', usage,
    workerSessionFile: workerFile, receiptCharacters: 15 });
  const out = await f.audit({ details: true });
  assert.equal(out.calls[0].worker.firstAssistantUsage.cacheRead, 0);
  assert.equal(out.calls[0].worker.assistantResponses, 2);
  assert.deepEqual(out.calls[0].worker.toolCalls, { read: 1 });
  assert.equal(out.calls[0].worker.toolResultCharacters, 'PRIVATE TOOL OUTPUT'.length);
  assert.equal(out.groups[0].workerUsage.input.sum, 10);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE TASK|PRIVATE TOOL OUTPUT|PRIVATE RECEIPT|PRIVATE\/file/);
  fs.unlinkSync(workerFile);
  const missing = await f.audit({ details: true });
  assert.equal(missing.calls[0].worker, null);
  assert.equal(missing.coverage.missingWorkerFiles, 1);
});

test('partial windows, changed guidance, legacy sessions and missing metrics stay explicit', async t => {
  const f = fixture(t);
  f.add('request', { requestId: 'old', delegateActive: true }, '2026-10-27T23:59:59Z');
  f.add('response', { requestId: 'old', calls: [] });
  f.add('outcome', { toolCallId: 'outside-start', status: 'completed' });
  f.add('request', { requestId: 'new', delegateActive: true, guidanceId: 'version-b' });
  f.add('response', { requestId: 'new', calls: [], stopReason: 'error' });
  f.rows.push({ type: 'message', timestamp: time,
    message: { role: 'toolResult', toolName: 'delegate', toolCallId: 'legacy', usage } });
  const out = await f.audit();
  assert.equal(out.coverage.unmatchedResponses, 1);
  assert.equal(out.coverage.unmatchedOutcomes, 1);
  assert.equal(out.coverage.legacyDelegateResults, 1);
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].errorResponses, 1);
  assert.deepEqual(out.groups[0].parentUsage.input, { sum: 0, known: 0, missing: 1 });
  assert.equal(out.groups[0].guidanceId, 'version-b');
  assert.equal(out.groups[0].delegatingResponses, 0);
  assert.equal(out.groups[0].answerOnlyResponses, 0);
});

test('CLI is usable without Pi or model credentials and validates the interval', t => {
  const f = fixture(t);
  f.save();
  const run = args => spawnSync(process.execPath, ['scripts/pi-delegate-audit.mjs', ...args], { encoding: 'utf8' });
  assert.equal(run(['--help']).status, 0);
  assert.equal(run(['--since', 'not-a-date', '--sessions', f.sessionsDir]).status, 1);
  const result = run(['--since', '2026-10-28', '--until', '2026-10-29', '--sessions', f.sessionsDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).groups, []);
});
