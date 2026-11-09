// Offline, metadata-only. Never sends prompts to a model or rewrites session files.
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) yield* files(join(dir, entry.name));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield join(dir, entry.name);
  }
}
async function* records(file, coverage) {
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { coverage.invalidJsonLines++; }
  }
}
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
function newUsage() { return Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'cost']
  .map(key => [key, { sum: 0, known: 0, missing: 0 }])); }
function addUsage(total, usage) {
  for (const [key, measurement] of Object.entries(total)) {
    const value = key === 'cost' ? usage?.cost?.total : usage?.[key];
    if (finite(value)) { measurement.sum += value; measurement.known++; }
    else measurement.missing++;
  }
}
async function workerMetadata(file, coverage) {
  let own = false, firstAssistantUsage = null, assistantResponses = 0, toolResultCharacters = 0;
  const toolCalls = {};
  for await (const row of records(file, coverage)) {
    if (row?.type === 'custom' && row.customType === 'delegate-origin') { own = true; continue; }
    const m = row?.message;
    if (!own || row?.type !== 'message') continue;
    if (m?.role === 'assistant') {
      if (assistantResponses++ === 0) firstAssistantUsage = m.usage ?? null;
      for (const c of m.content ?? []) if (c.type === 'toolCall') toolCalls[c.name] = (toolCalls[c.name] ?? 0) + 1;
    }
    if (m?.role === 'toolResult') for (const c of m.content ?? []) {
      if (c.type === 'text') toolResultCharacters += c.text.length;
    }
  }
  return { originFound: own, assistantResponses, firstAssistantUsage, toolCalls, toolResultCharacters };
}

export async function auditDelegation({ sessionsDir, since, until, details = false }) {
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) throw new Error('Invalid audit interval');
  const coverage = { filesScanned: 0, invalidJsonLines: 0, invalidAuditRecords: 0,
    duplicatesSkipped: 0, conflictingEventIds: 0, legacyDelegateResults: 0, missingWorkerFiles: 0,
    unmatchedResponses: 0, unmatchedOutcomes: 0, unlinkedResponses: 0 };
  const seen = new Map(), requests = new Map(), responses = new Map(), calls = new Map(), outcomes = new Map();
  const configurations = new Set();
  for await (const file of files(sessionsDir)) {
    coverage.filesScanned++;
    // Legacy calls are counted separately, never mistaken for observed non-use.
    const legacy = [];
    const instrumentedCalls = new Set();
    for await (const row of records(file, coverage)) {
      const time = Date.parse(row?.timestamp);
      if (!Number.isFinite(time) || time < since || time >= until) continue;
      if (row?.type === 'message' && row.message?.role === 'toolResult' && row.message.toolName === 'delegate') {
        legacy.push(`${row.message.toolCallId}`);
      }
      if (row?.type !== 'custom' || row.customType !== 'delegate-audit') continue;
      const d = row.data;
      if (d?.kind === 'call' || d?.kind === 'outcome') instrumentedCalls.add(d.toolCallId);
      if (d?.schemaVersion !== 1 || typeof d.eventId !== 'string') { coverage.invalidAuditRecords++; continue; }
      const signature = JSON.stringify(d);
      if (seen.has(d.eventId)) {
        if (seen.get(d.eventId) !== signature) coverage.conflictingEventIds++;
        else coverage.duplicatesSkipped++;
        continue;
      }
      seen.set(d.eventId, signature);
      const event = { ...d, timestamp: row.timestamp, sessionFile: file, entryId: row.id };
      if (d.kind === 'configuration') configurations.add(d.guidanceId);
      else if (d.kind === 'request') { requests.set(d.requestId, event); configurations.add(d.guidanceId); }
      else if (d.kind === 'response') {
        if (d.requestId) responses.set(d.requestId, event);
        else coverage.unlinkedResponses++;
      }
      else if (d.kind === 'call') calls.set(`${d.parentSessionId}/${d.toolCallId}`, event);
      else if (d.kind === 'outcome') outcomes.set(`${d.parentSessionId}/${d.toolCallId}`, event);
    }
    // Legacy records can survive copies too; report this as rows, not unique calls.
    coverage.legacyDelegateResults += legacy.filter(id => !instrumentedCalls.has(id)).length;
  }
  coverage.unmatchedResponses = [...responses.keys()].filter(id => !requests.has(id)).length;
  coverage.unmatchedOutcomes = [...outcomes.keys()].filter(id => !calls.has(id)).length;
  const groups = new Map();
  const groupFor = event => {
    const key = `${event.provider ?? 'unknown'}/${event.model ?? 'unknown'}@${event.guidanceId}`;
    if (!groups.has(key)) groups.set(key, { model: `${event.provider ?? 'unknown'}/${event.model ?? 'unknown'}`,
      guidanceId: event.guidanceId, parentRequestIntents: 0, activeRequests: 0,
      responses: 0, delegatingResponses: 0, directToolResponses: 0, answerOnlyResponses: 0,
      errorResponses: 0, unansweredRequests: 0, workerCalls: 0, userInvokedCalls: 0, outcomes: {}, elapsedMs: [],
      parentUsage: newUsage(), workerUsage: newUsage(), userTurns: new Set() });
    return groups.get(key);
  };
  for (const [id, req] of requests) {
    const g = groupFor(req);
    g.parentRequestIntents++;
    if (!req.delegateActive) continue;
    g.activeRequests++;
    if (req.userEntryId) g.userTurns.add(`${req.parentSessionId}/${req.userEntryId}`);
    const response = responses.get(id);
    if (!response) { g.unansweredRequests++; continue; }
    g.responses++;
    addUsage(g.parentUsage, response.usage);
    if (['error', 'aborted'].includes(response.stopReason)) g.errorResponses++;
    else if (response.calls?.some(c => c.name === 'delegate')) g.delegatingResponses++;
    else if (response.calls?.length) g.directToolResponses++;
    else g.answerOnlyResponses++;
  }
  const timeline = [];
  for (const [key, call] of calls) {
    const req = requests.get(call.requestId);
    const g = groupFor(req ?? call);
    g.workerCalls++;
    if (call.invokedBy === 'user') g.userInvokedCalls++; // /do: user choice, not model delegation.
    const result = outcomes.get(key);
    const status = result?.status ?? 'unfinished';
    g.outcomes[status] = (g.outcomes[status] ?? 0) + 1;
    if (finite(result?.elapsedMs)) g.elapsedMs.push(result.elapsedMs);
    // Rejected/missing calls have unknown usage, not zero. Never add the parent's
    // nested tool-result usage as well as this same worker outcome.
    addUsage(g.workerUsage, result?.usage);
    if (details) {
      let worker = null;
      if (result?.workerSessionFile) {
        try { worker = await workerMetadata(result.workerSessionFile, coverage); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          coverage.missingWorkerFiles++;
        }
      }
      timeline.push({ timestamp: call.timestamp, requestId: call.requestId, toolCallId: call.toolCallId,
        parentSessionFile: call.sessionFile, parentAuditEntryId: call.entryId,
        parentEntryId: req?.parentEntryId ?? null, userEntryId: req?.userEntryId ?? null,
        guidanceId: call.guidanceId, invokedBy: call.invokedBy ?? 'model', status, elapsedMs: result?.elapsedMs ?? null,
        workerSessionFile: result?.workerSessionFile ?? null, usage: result?.usage ?? null,
        receiptCharacters: result?.receiptCharacters ?? null, worker });
    }
  }
  return { schemaVersion: 1, since: new Date(since).toISOString(), until: new Date(until).toISOString(),
    coverage, guidanceVersionsSeen: [...configurations],
    groups: [...groups.values()].map(({ userTurns, elapsedMs, ...g }) => ({ ...g,
      observedUserTurns: userTurns.size,
      delegationResponseFraction: g.responses ? g.delegatingResponses / g.responses : null,
      elapsedMs: { samples: elapsedMs.length, total: elapsedMs.reduce((a, b) => a + b, 0) } })),
    ...(details ? {
      requests: [...requests.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).map(req => {
        const response = responses.get(req.requestId);
        return { timestamp: req.timestamp, requestId: req.requestId, parentSessionFile: req.sessionFile,
          parentEntryId: req.parentEntryId ?? null, userEntryId: req.userEntryId ?? null,
          guidanceId: req.guidanceId, model: `${req.provider ?? 'unknown'}/${req.model ?? 'unknown'}`,
          delegateActive: req.delegateActive,
          response: response ? { auditEntryId: response.entryId, provider: response.provider, model: response.model,
            stopReason: response.stopReason, calls: response.calls, usage: response.usage ?? null,
            replyCharacters: response.replyCharacters ?? null } : null };
      }),
      calls: timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    } : {}),
    limitations: ['Request intents are not proof of HTTP dispatch; active tool is not proof of final declaration.',
      'Rates describe observed assistant responses, not task suitability or user satisfaction.',
      'Partial windows/crashes can leave unmatched events; unfinished is not automatically failure.',
      'Usage is Pi-normalized telemetry and catalog-valued cost, not subscription allowance or billed spend.',
      'Only audit-enabled sessions have a non-use denominator; legacy results are separate rows.'] };
}
