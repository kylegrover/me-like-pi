// S1 research helpers, not a production delegation API. Synthetic/local input only.
import { createHash } from 'node:crypto';

export function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Compare semantic JSON fields, NOT provider tokens, billing, or cache occupancy.
export function comparePayloads(parent, child) {
  const a = parent.input ?? [], b = child.input ?? [];
  let commonItems = 0;
  while (commonItems < Math.min(a.length, b.length) &&
    JSON.stringify(a[commonItems]) === JSON.stringify(b[commonItems])) commonItems++;
  const controls = payload => Object.fromEntries(Object.entries(payload)
    .filter(([key]) => !['input', 'prompt_cache_key'].includes(key)));
  return {
    parentItems: a.length, childItems: b.length, commonItems,
    fullInputPrefix: commonItems === a.length,
    sameInstructions: parent.instructions === child.instructions,
    sameTopLevelTools: digest(parent.tools ?? []) === digest(child.tools ?? []),
    sameControlsExceptCacheKey: digest(controls(parent)) === digest(controls(child)),
    sameCacheKey: parent.prompt_cache_key === child.prompt_cache_key,
    parentInputHash: digest(a), childInputHash: digest(b),
  };
}

export function assertCompleteToolPairs(messages) {
  const pending = new Set(), seen = new Set();
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'toolResult') {
      if (!pending.delete(message.toolCallId)) throw new Error('Orphan or duplicate tool result');
      continue;
    }
    if (pending.size) throw new Error('Incomplete tool batch');
    if (message.role === 'assistant') {
      if (['pending', 'error', 'aborted', 'deferred'].includes(message.stopReason)) {
        throw new Error('Incomplete assistant message');
      }
      for (const block of message.content) {
        if (block.type !== 'toolCall') continue;
        if (seen.has(block.id)) throw new Error('Duplicate tool call ID');
        seen.add(block.id);
        pending.add(block.id);
      }
    }
  }
  if (pending.size) throw new Error('Incomplete tool batch');
}

// Conservative fallback if snapshotting at tool execution: omit the entire current
// assistant batch and all sibling outputs. Never let Pi invent missing results.
// Preferred production boundary is the captured, finalized parent request BEFORE
// the assistant generated this batch; its provider payload is the comparison baseline.
export function snapshotBeforeDispatch(messages, delegateCallId) {
  const index = messages.findIndex(message => message.role === 'assistant' &&
    message.content.some(block => block.type === 'toolCall' && block.id === delegateCallId));
  if (index < 0) throw new Error('Dispatch call not found');
  const trailing = messages.slice(index + 1);
  const batch = new Set(messages[index].content.filter(b => b.type === 'toolCall').map(b => b.id));
  if (trailing.some(m => m.role !== 'system' &&
    !(m.role === 'toolResult' && batch.has(m.toolCallId)))) {
    throw new Error('Snapshot contains later conversation');
  }
  const snapshot = structuredClone(messages.slice(0, index));
  assertCompleteToolPairs(snapshot);
  return { messages: snapshot, omittedBatchCalls: batch.size };
}

export function syntheticTools() {
  const parameters = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  return ['read', 'edit', 'delegate'].map(name => ({ name, description: `Synthetic ${name}`, parameters }));
}

export function syntheticAssistant(model, content, stopReason = 'stop') {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content, stopReason, timestamp: 2, thinkingLevel: 'medium',
    usage: { input: 11, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 13,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

export function syntheticTranscript(model) {
  return [
    { role: 'system', content: '', sections: { preamble: 'Synthetic coding assistant.', cwd: '/synthetic' },
      toolsAdded: syntheticTools(), timestamp: 0 },
    { role: 'user', content: 'Keep proposals distinct from verified work. Update our notes when asked.', timestamp: 1 },
    syntheticAssistant(model, [{ type: 'text', text: 'The retry decision is documented.',
      textSignature: JSON.stringify({ v: 1, id: 'msg_synthetic', phase: 'final_answer' }) }]),
    { role: 'system', content: '', toolsAdded: [{ name: 'find', description: 'Synthetic find',
      parameters: { type: 'object', properties: {} } }], timestamp: 3 },
    { role: 'user', content: 'The notes live in docs/PLAN.md.', timestamp: 4 },
  ];
}
