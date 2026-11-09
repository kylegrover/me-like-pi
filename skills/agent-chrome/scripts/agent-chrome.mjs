#!/usr/bin/env node
// agent-chrome: drive a dedicated, persistent agent Chrome profile over loopback CDP.
// No telemetry, no update checks, no cloud, no network access other than 127.0.0.1 DevTools.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { Browser, BrowserError } from './lib/browser.mjs';
import { paths, port, sessionName } from './lib/config.mjs';
import { connect, endpoint, fileStore, NotRunningError, start, stop } from './lib/connect.mjs';

const HELP = `agent-chrome — control the dedicated agent Chrome (separate profile, persistent logins)

  agent-chrome start             launch agent Chrome if not running (visible window)
  agent-chrome stop              close agent Chrome
  agent-chrome status            running? port, profile, session tabs
  agent-chrome tabs              list tabs (* = this session's current, + = opened by it)
  agent-chrome cleanup           close tabs this session opened
  agent-chrome release           stop tracking this session's tabs, leave them open for the user
  agent-chrome [run] [file.js]   run a JavaScript snippet (stdin if no file) with helpers in scope

Snippet helpers (all async; await them; return a value to print it):
  open(url) goto(url) back() use(tab) show() close(tab?) tabs() info()
  snapshot({max}) text(selector?) js(expr, {frame}) frames()
  click(ref|selector|{x,y}) fill(ref|selector, text) type(text) press(key, mods?) scroll({dy})
  upload(ref|selector, path|paths) dialog(accept, promptText?) screenshot({full, max, path})
  waitForLoad() waitFor(selector, {timeout, visible}) waitForIdle() sleep(ms) raw(method, params)

Options: --session NAME (or AGENT_CHROME_SESSION)  --timeout SECONDS (default 120)
Env: AGENT_CHROME_PORT (default 9333)  AGENT_CHROME_HOME  AGENT_CHROME_BIN`;

const HELPERS = ['open', 'goto', 'back', 'use', 'show', 'close', 'tabs', 'info', 'snapshot', 'text', 'js', 'frames',
  'click', 'fill', 'type', 'press', 'scroll', 'upload', 'dialog', 'screenshot', 'waitForLoad', 'waitFor', 'waitForIdle', 'raw'];

export function parseArgs(argv) {
  const opts = { session: process.env.AGENT_CHROME_SESSION, timeout: 120, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session') opts.session = argv[++i];
    else if (a.startsWith('--session=')) opts.session = a.slice(10);
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a.startsWith('--timeout=')) opts.timeout = Number(a.slice(10));
    else if (a === '-h' || a === '--help') opts.help = true;
    else opts.rest.push(a);
  }
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new BrowserError('--timeout must be a positive number of seconds');
  opts.session = sessionName(opts.session);
  return opts;
}

export function format(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return inspect(value, { depth: 6, breakLength: 120, maxArrayLength: 200, maxStringLength: 4000 });
}

const readStdin = async () => {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
};

/** Run a snippet as an async function with the browser helpers bound as locals. */
export async function runSnippet(browser, code, { log = console.log } = {}) {
  const bound = HELPERS.map((name) => browser[name].bind(browser));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const AsyncFunction = (async () => {}).constructor;
  const fn = new AsyncFunction(...HELPERS, 'sleep', 'browser', 'console', `"use strict";\n${code}`);
  const consoleProxy = { log: (...a) => log(a.map(format).join(' ')), error: (...a) => log(a.map(format).join(' ')) };
  return fn(...bound, sleep, browser, consoleProxy);
}

async function withBrowser(opts, work) {
  const p = paths();
  const cdp = await connect({ p, debugPort: port() });
  const browser = new Browser(cdp, fileStore(p.state, opts.session), { shotsDir: p.shots });
  let timer;
  try {
    return await Promise.race([
      work(browser),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new BrowserError(`Timed out after ${opts.timeout}s`)), opts.timeout * 1000); }),
    ]);
  } finally {
    clearTimeout(timer);
    await browser.detach().catch(() => {});
    cdp.close();
  }
}

const tabLine = (t, i) => `${t.current ? '*' : ' '}${t.owned ? '+' : ' '} ${i + 1}. ${t.id.slice(0, 8)} ${t.title || '(untitled)'} — ${t.url}`;

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const [cmd, ...args] = opts.rest;
  if (opts.help || cmd === 'help') return console.log(HELP);
  const p = paths(), debugPort = port();
  switch (cmd) {
    case 'start': {
      const r = await start({ p, debugPort });
      console.log(r.started ? `Started agent Chrome on 127.0.0.1:${debugPort} (profile ${p.profile}).` +
        (r.firstRun ? '\nNew profile: sign in to any sites the agent needs, in that window.' : '') : `Agent Chrome already running on 127.0.0.1:${debugPort}.`);
      return;
    }
    case 'stop': return console.log((await stop({ p, debugPort })) ? 'Closed agent Chrome.' : 'Agent Chrome was not running.');
    case 'status': {
      const url = await endpoint({ p, debugPort }).catch((e) => { console.log(e.message); return null; });
      console.log(`agent Chrome: ${url ? `running on 127.0.0.1:${debugPort}` : 'not running'}\nprofile: ${p.profile}\nsession: ${opts.session}`);
      if (url) await withBrowser(opts, async (b) => { const t = await b.tabs(); t.forEach((x, i) => console.log(tabLine(x, i))); });
      return;
    }
    case 'tabs': return withBrowser(opts, async (b) => (await b.tabs()).forEach((t, i) => console.log(tabLine(t, i))));
    case 'cleanup': return withBrowser(opts, async (b) => console.log(`Closed ${(await b.cleanup()).length} tab(s) opened by session ${opts.session}.`));
    case 'release': return withBrowser(opts, async (b) => console.log(`Released ${b.release().length} tab(s) to the user.`));
    case undefined: case 'run': {
      const file = cmd === 'run' ? args[0] : undefined;
      const code = file ? readFileSync(file, 'utf8') : await readStdin();
      if (!code.trim()) return console.log(HELP);
      const out = await withBrowser(opts, (b) => runSnippet(b, code));
      const text = format(out);
      if (text) console.log(text);
      return;
    }
    default: throw new BrowserError(`Unknown command ${cmd}. Run agent-chrome --help.`);
  }
}

const real = (f) => { try { return realpathSync(f); } catch { return f; } };
const invoked = !!process.argv[1] && real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
if (invoked) {
  main().catch((err) => {
    const expected = err instanceof BrowserError || err instanceof NotRunningError || err?.constructor?.name === 'CdpError' || /^Invalid session|AGENT_CHROME_PORT|Chrome not found|Refusing non-local|Agent Chrome (is on|did not)/.test(err?.message);
    console.error(`agent-chrome: ${expected ? err.message : (err?.stack || err)}`);
    process.exitCode = 1;
  });
}
