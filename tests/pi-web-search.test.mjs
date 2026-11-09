import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchSearxng, shapeResults, parseEndpoint, formatSearxng, loadConfig, MAX_RESPONSE_BYTES } from '../extensions/lib/searxng-client.ts';

const sample = {
  query: 'rust lifetimes', number_of_results: 3,
  results: [
    { url: 'https://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html', title: 'Validating References with Lifetimes',
      content: 'Lifetimes are another kind of generic   that we’ve already been using.', engine: 'duckduckgo', engines: ['duckduckgo', 'brave'] },
    { url: 'https://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html', title: 'dup', content: 'dup', engines: ['bing'] },
    { url: 'javascript:alert(1)', title: 'bad scheme' },
    { url: 'https://stackoverflow.com/q/1', title: '', content: 'x'.repeat(1000), engine: 'stackoverflow' },
  ],
  answers: ['Lifetimes ensure references are valid.'],
  suggestions: ['rust lifetime elision'],
  unresponsive_engines: [['google', 'CAPTCHA'], ['qwant', 'timeout']],
};

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.closeAllConnections?.(); await new Promise(r => server.close(r)); }
}

test('parseEndpoint rejects bad urls, embedded credentials and query strings', () => {
  assert.equal(parseEndpoint('http://searxng.local:8888/search').href, 'http://searxng.local:8888/search');
  for (const bad of [undefined, '', 'nope', 'ftp://x/search', 'http://u:p@x/search', 'http://x/search?q=1', 'http://x/search#f'])
    assert.throws(() => parseEndpoint(bad));
});

test('shapeResults dedupes, drops unsafe urls, clips, and reports failed engines', () => {
  const r = shapeResults(sample, 8);
  assert.equal(r.hits.length, 2);
  assert.equal(r.hits[0].snippet, 'Lifetimes are another kind of generic that we’ve already been using.');
  assert.deepEqual(r.hits[0].engines, ['duckduckgo', 'brave']);
  assert.equal(r.hits[1].title, 'https://stackoverflow.com/q/1');
  assert.ok(r.hits[1].snippet.length <= 400);
  assert.deepEqual(r.unresponsiveEngines, ['google: CAPTCHA', 'qwant: timeout']);
  assert.equal(shapeResults(sample, 1).hits.length, 1);
  assert.throws(() => shapeResults({ nope: 1 }, 8), /format=json/);
  const text = formatSearxng('rust lifetimes', 0, r);
  assert.match(text, /^Query 1: rust lifetimes/);
  assert.match(text, /1\. Validating References/);
  assert.match(text, /Engines that failed: google: CAPTCHA/);
  assert.match(formatSearxng('q', 1, { hits: [], answers: [], suggestions: [], unresponsiveEngines: [] }), /\(no results\)/);
});

test('searchSearxng sends one GET with format=json and bearer key; handles server errors', async () => {
  const seen = [];
  await withServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    const q = new URL(req.url, 'http://x').searchParams.get('q');
    if (q === 'forbidden') { res.writeHead(403); return res.end('Forbidden'); }
    if (q === 'limited') { res.writeHead(429); return res.end(); }
    if (q === 'redirect') { res.writeHead(302, { location: 'http://evil.example/' }); return res.end(); }
    if (q === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>'); }
    if (q === 'huge') { res.writeHead(200); return res.end('x'.repeat(MAX_RESPONSE_BYTES + 10)); }
    if (q === 'slow') return; // never answers
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(sample));
  }, async base => {
    const cfg = { url: `${base}/search`, apiKey: 'KEY', engines: 'duckduckgo,brave', maxResults: 5 };
    const r = await searchSearxng('rust lifetimes', cfg);
    assert.equal(r.hits.length, 2);
    const sent = new URL(seen[0].url, 'http://x');
    assert.equal(sent.pathname, '/search');
    assert.equal(sent.searchParams.get('format'), 'json');
    assert.equal(sent.searchParams.get('engines'), 'duckduckgo,brave');
    assert.equal(seen[0].auth, 'Bearer KEY');
    await searchSearxng('no key', { url: `${base}/search` });
    assert.equal(seen[1].auth, undefined);
    await assert.rejects(searchSearxng('forbidden', cfg), /403.*format=json/);
    await assert.rejects(searchSearxng('limited', cfg), /429.*limiter/);
    await assert.rejects(searchSearxng('redirect', cfg), /redirect blocked/);
    await assert.rejects(searchSearxng('html', cfg), /non-JSON/);
    await assert.rejects(searchSearxng('huge', cfg), /size limit/);
    await assert.rejects(searchSearxng('slow', cfg, undefined, fetch, 200), /timed out/);
    await assert.rejects(searchSearxng('x'.repeat(241), cfg), /query length/);
  });
  await assert.rejects(searchSearxng('q', { url: 'http://127.0.0.1:1/search' }), /unreachable/);
});

test('loadConfig: explicit backend only, key file, readable errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-search-cfg-'));
  try {
    const f = join(dir, 'c.json');
    assert.throws(() => loadConfig(f), /not configured/);
    await writeFile(f, '{bad'); assert.throws(() => loadConfig(f), /unreadable/);
    await writeFile(f, '{}'); assert.throws(() => loadConfig(f), /backend must be/);
    await writeFile(f, '{"backend":"searxng","searxng":{}}'); assert.throws(() => loadConfig(f), /url is not configured/);
    await writeFile(f, '{"backend":"codex"}'); assert.deepEqual(loadConfig(f), { backend: 'codex' });
    await writeFile(join(dir, 'k'), ' SECRET\n');
    await writeFile(f, JSON.stringify({ backend: 'searxng', searxng: { url: 'http://h:8888/search', apiKeyFile: join(dir, 'k'), maxResults: 4 } }));
    const c = loadConfig(f);
    assert.equal(c.searxng.apiKey, 'SECRET');
    assert.equal(c.searxng.maxResults, 4);
    await writeFile(f, JSON.stringify({ backend: 'searxng', searxng: { url: 'http://h/search', apiKeyFile: join(dir, 'missing') } }));
    assert.throws(() => loadConfig(f), /apiKeyFile/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
