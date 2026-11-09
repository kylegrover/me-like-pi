import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { piDependency } from './helpers/pi-package.mjs';

const root = process.env.PI_PACKAGE_ROOT;
const ext = resolve('extensions/pi-web-search.ts').replaceAll('\\', '/');

async function load(path) {
  const { loadExtensions } = await import(pathToFileURL(resolve(root, 'dist/core/extensions/loader.js')).href);
  const result = await loadExtensions([path], process.cwd());
  assert.deepEqual(result.errors, []);
  const extension = result.extensions[0];
  return { extension, tool: extension.tools.get('web_search').definition,
    emit: name => { for (const fn of extension.handlers.get(name) ?? []) fn(); } };
}
const ctx = { modelRegistry: { getApiKeyForProvider: async () => 'FAKE' } };
const execute = (tool, queries = ['docs']) => tool.execute('fixture', { queries }, undefined, undefined, ctx);
const theme = { fg: (_c, t) => t };
const render = (tool, result, expanded = false) => tool.renderResult(result, { expanded, isPartial: false }, theme).render(160).join('\n');

async function fixture(body, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-search-native-'));
  try {
    const entry = join(dir, 'index.ts');
    await writeFile(entry, `import { registerWebSearch } from ${JSON.stringify(ext)};\nexport default function(pi) {\n${body}\n}`);
    return await fn(await load(entry));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('real entry loads web_search with bounded schema; unconfigured is a readable error', { skip: !root }, async () => {
  const prev = process.env.PI_WEB_SEARCH_CONFIG;
  process.env.PI_WEB_SEARCH_CONFIG = join(tmpdir(), 'pi-web-search-does-not-exist.json');
  try {
    const { extension, tool, emit } = await load(resolve('extensions/pi-web-search.ts'));
    assert.deepEqual([...extension.tools.keys()], ['web_search']);
    const { validateToolArguments } = await import(pathToFileURL(piDependency(root, '@earendil-works/pi-ai', 'dist/utils/validation.js')).href);
    const validate = args => validateToolArguments(tool, { id: 'f', name: tool.name, arguments: args });
    assert.deepEqual(validate({ queries: ['a', 'b', 'c'] }), { queries: ['a', 'b', 'c'] });
    assert.throws(() => validate({ queries: ['a', 'b', 'c', 'd'] }));
    await assert.rejects(execute(tool), /No active/);
    emit('before_agent_start');
    await assert.rejects(execute(tool), /not configured/);
    await assert.rejects(execute(tool), /blocked after a failure/);
  } finally {
    if (prev === undefined) delete process.env.PI_WEB_SEARCH_CONFIG; else process.env.PI_WEB_SEARCH_CONFIG = prev;
  }
});

test('searxng backend: results, follow-ups, partial-failure lockout, rendering', { skip: !root }, async () => {
  await fixture(`
  registerWebSearch(pi, {
    load: () => ({ backend: 'searxng', searxng: { url: 'http://mesh-host:8888/search' } }),
    searxng: async (query) => {
      if (query === 'fail') throw new Error('SearXNG HTTP 502');
      return { hits: [{ title: 'Doc ' + query, url: 'https://example.org/' + encodeURIComponent(query), snippet: 'snip', engines: ['brave'] }],
        answers: [], suggestions: [], unresponsiveEngines: query === 'flaky' ? ['google: CAPTCHA'] : [] };
    },
    codex: async () => { throw new Error('codex must not be called'); },
  });`, async ({ tool, emit }) => {
    emit('before_agent_start');
    const first = await execute(tool, ['docs', 'flaky']);
    assert.equal(first.details.backend, 'searxng');
    assert.equal(first.details.hitCount, 2);
    assert.equal(first.details.failedEngines, 1);
    assert.equal(first.details.endpoint, 'http://mesh-host:8888');
    assert.match(first.content[0].text, /SearXNG search: 2\/2 queries completed/);
    assert.match(first.content[0].text, /Query 2: flaky\n1\. Doc flaky\n   https:\/\/example.org\/flaky/);
    assert.match(first.content[0].text, /Engines that failed: google: CAPTCHA/);
    assert.match(render(tool, first), /searxng · 2\/2 completed .* 2 results · 1 engine failures/);
    assert.doesNotMatch(render(tool, first), /Doc docs/);
    assert.match(render(tool, first, true), /Doc docs/);
    assert.equal((await execute(tool, ['follow-up'])).details.completedQueryCount, 1);
    const partial = await execute(tool, ['ok', 'fail', 'never']);
    assert.equal(partial.details.failedQueryCount, 1);
    assert.equal(partial.details.notAttemptedQueryCount, 1);
    assert.match(partial.content[0].text, /Query 2: FAILED \(SearXNG HTTP 502\)/);
    await assert.rejects(execute(tool), /blocked after a failure/);
    emit('agent_settled'); emit('before_agent_start');
    await assert.rejects(execute(tool, ['fail']), /SearXNG\) failed: SearXNG HTTP 502/);
    emit('agent_settled'); emit('before_agent_start');
    assert.equal((await execute(tool)).details.completedQueryCount, 1);
  });
});

test('codex backend: uses login, never touches searxng', { skip: !root }, async () => {
  await fixture(`
  registerWebSearch(pi, {
    load: () => ({ backend: 'codex' }),
    searxng: async () => { throw new Error('searxng must not be called'); },
    codex: async (query, token, account) => ({ text: 'Answer for ' + query + ' ' + token + '/' + account,
      citations: [{ title: 'Ref', url: 'https://example.org' }], searchCalls: 1, usage: { inputTokens: 1 } }),
    readCredential: () => ({ type: 'oauth', accountId: 'ACCT' }),
  });`, async ({ tool, emit }) => {
    emit('before_agent_start');
    const r = await execute(tool, ['q']);
    assert.equal(r.details.backend, 'codex');
    assert.match(r.content[0].text, /Answer for q FAKE\/ACCT/);
    assert.match(r.content[0].text, /- Ref: https:\/\/example.org/);
    assert.match(render(tool, r), /^codex · 1\/1 completed/);
  });
});

test('stale run cannot dispatch after session change', { skip: !root }, async () => {
  await fixture(`
  let calls = 0;
  globalThis.__webSearchCalls = () => calls;
  registerWebSearch(pi, {
    load: () => ({ backend: 'searxng', searxng: { url: 'http://h/search' } }),
    searxng: (_q, _c, signal) => { calls++; return new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason))); },
  });`, async ({ tool, emit }) => {
    emit('before_agent_start');
    const old = execute(tool, ['a', 'b']);
    await new Promise(r => setTimeout(r, 10));
    emit('session_shutdown'); emit('session_start'); emit('before_agent_start');
    await assert.rejects(old, /run ended|session changed/i);
    assert.equal(globalThis.__webSearchCalls(), 1);
  });
});
