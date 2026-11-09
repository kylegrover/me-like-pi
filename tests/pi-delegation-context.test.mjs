import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCompleteToolPairs, snapshotBeforeDispatch, syntheticAssistant,
  syntheticTranscript, comparePayloads } from '../scripts/lib/delegation-context-spike.mjs';

const model = { api: 'synthetic', provider: 'synthetic', id: 'synthetic' };
const call = (id, name = 'read') => ({ type: 'toolCall', id, name, arguments: { path: 'docs/PLAN.md' } });
const result = id => ({ role: 'toolResult', toolCallId: id, toolName: 'read',
  content: [{ type: 'text', text: 'evidence' }], isError: false, timestamp: 3 });

test('dispatch snapshot excludes entire pending sibling batch and does not alias parent', () => {
  const prefix = syntheticTranscript(model);
  const parent = [...prefix, syntheticAssistant(model, [call('delegate', 'delegate'), call('sibling')], 'toolUse'),
    result('sibling')];
  const before = structuredClone(parent);
  const snapshot = snapshotBeforeDispatch(parent, 'delegate');
  assert.equal(snapshot.omittedBatchCalls, 2);
  assert.deepEqual(snapshot.messages, prefix);
  snapshot.messages[0].sections.preamble = 'child change';
  assert.deepEqual(parent, before);
  assert.throws(() => snapshotBeforeDispatch([...parent, { role: 'user', content: 'future' }], 'delegate'), /later conversation/);
  assert.throws(() => snapshotBeforeDispatch(parent, 'missing'), /not found/);
});

test('tool pairing fails closed rather than relying on synthetic provider results', () => {
  const assistant = syntheticAssistant(model, [call('a'), call('b')], 'toolUse');
  assert.doesNotThrow(() => assertCompleteToolPairs([assistant, result('a'),
    { role: 'system', content: 'tail' }, result('b')]));
  for (const history of [[assistant], [assistant, result('a')], [result('a')],
    [assistant, result('a'), result('a')], [assistant, { role: 'user', content: 'interrupt' }]]) {
    assert.throws(() => assertCompleteToolPairs(history));
  }
  assert.throws(() => assertCompleteToolPairs([syntheticAssistant(model, [], 'pending')]), /Incomplete assistant/);
});

test('payload comparisons distinguish input reuse candidates from cache identity and controls', () => {
  const parent = { input: [{ role: 'user', content: 'same' }], model: 'a', prompt_cache_key: 'parent' };
  const c = comparePayloads(parent, { ...parent, input: [...parent.input, { role: 'user', content: 'new' }],
    prompt_cache_key: 'child' });
  assert.equal(c.fullInputPrefix, true);
  assert.equal(c.sameControlsExceptCacheKey, true);
  assert.equal(c.sameCacheKey, false);
  assert.equal(comparePayloads(parent, { ...parent, model: 'b' }).sameControlsExceptCacheKey, false);
});
