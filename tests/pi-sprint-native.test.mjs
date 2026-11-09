import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Optional offline compatibility checks against the Pi installation being targeted.
// No auth files, live sessions, provider requests, or service calls are used.
const root = process.env.PI_PACKAGE_ROOT;
const native = (path) => import(pathToFileURL(resolve(root, path)).href);

test('native Pi loader accepts extension and registers expected commands', { skip: !root }, async (t) => {
  let loadExtensions;
  try { ({ loadExtensions } = await native('dist/core/extensions/loader.js')); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes("'@earendil-works/pi-server'")) {
      t.skip('Installed Pi loader is missing @earendil-works/pi-server; full loader compatibility remains unverified.');
      return;
    }
    throw error;
  }
  const result = await loadExtensions([resolve('extensions/pi-sprint.ts')], process.cwd());
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0];
  assert.deepEqual([...extension.commands.keys()].sort(), ['closeout', 'handback', 'handoff', 'pivot', 'sprint-stop']);
  assert.ok(extension.handlers.has('agent_settled'));
});

test('installed jiti loads the extension TypeScript without new dependencies', { skip: !root }, async () => {
  const require = createRequire(resolve(root, 'package.json'));
  const { createJiti } = require('jiti');
  const jiti = createJiti(import.meta.url);
  const { default: factory } = await jiti.import(resolve('extensions/pi-sprint.ts'));
  const commands = [];
  factory({ on() {}, registerTool() {}, registerCommand: name => commands.push(name) });
  assert.deepEqual(commands.sort(), ['closeout', 'handback', 'handoff', 'pivot', 'sprint-stop']);
});

test('native SessionManager retains final recap across compaction and reload-shaped context building', { skip: !root }, async () => {
  const { SessionManager } = await native('dist/core/session-manager.js');
  const sm = SessionManager.inMemory(process.cwd());
  sm.appendMessage({ role: 'user', content: 'old work', timestamp: 1 });
  const keep = sm.appendMessage({ role: 'user', content: 'wrap up', timestamp: 2 });
  const recap = { role: 'assistant', content: [{ type: 'text', text: 'Exact final recap\n<!-- pi-sprint-ready:test -->' }],
    timestamp: 3, stopReason: 'stop', api: 'test', model: 'test', provider: 'test',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  sm.appendMessage(recap);
  sm.appendCompaction('Summary', keep, 1000);
  const context = sm.buildContextEntries();
  const retained = context.flatMap(e => e.type === 'message' ? [e.message]
    : e.type === 'compaction' ? e.retainedTail ?? [] : []);
  assert.deepEqual(retained.find(m => m.role === 'assistant'), recap);
  assert.deepEqual(sm.buildSessionContext().messages.find(m => m.role === 'assistant'), recap);
});
