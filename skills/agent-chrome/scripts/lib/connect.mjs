// Launch / attach / stop the dedicated agent Chrome. Only ever touches the agent profile.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CdpClient, connectWebSocket } from './cdp.mjs';
import { assertLoopback, chromeArgs, findChrome, paths as defaultPaths, port as defaultPort, readActivePort } from './config.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class NotRunningError extends Error {}

/** Per-session JSON state (current tab + owned tabs), written atomically. */
export function fileStore(stateDir, session) {
  const file = join(stateDir, `session-${session}.json`);
  return {
    file,
    load() { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } },
    save(state) {
      mkdirSync(stateDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, file);
    },
  };
}

/** Browser-level WebSocket URL currently served on the loopback port, or null. */
export async function liveBrowser(debugPort, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const { webSocketDebuggerUrl } = await res.json();
    return webSocketDebuggerUrl ? assertLoopback(webSocketDebuggerUrl) : null;
  } catch (err) {
    if (/non-local/.test(err?.message)) throw err;
    return null;
  }
}

// Chrome (156) does not always write DevToolsActivePort for a fixed port, so `start` records
// the browser id of the instance it launched. Each browser run gets a fresh id.
const recordFile = (p) => join(p.state, 'browser.json');
export function readRecord(p) { try { return JSON.parse(readFileSync(recordFile(p), 'utf8')); } catch { return null; } }
function writeRecord(p, record) { mkdirSync(p.state, { recursive: true }); writeFileSync(recordFile(p), JSON.stringify(record)); }

/**
 * The live DevTools endpoint of the agent browser, or null. Only accepts the browser instance
 * we launched (recorded id) or that our profile's DevToolsActivePort names; never another browser.
 */
export async function endpoint({ p = defaultPaths(), debugPort = defaultPort(), fetchImpl = fetch } = {}) {
  const url = await liveBrowser(debugPort, fetchImpl);
  if (!url) return null;
  const id = new URL(url).pathname;
  const active = readActivePort(p.profile);
  if (active && active.port === debugPort && new URL(active.url).pathname === id) return url;
  const record = readRecord(p);
  if (record && record.port === debugPort && record.browserPath === id) return url;
  return null;
}

export async function start({ p = defaultPaths(), debugPort = defaultPort(), env = process.env, spawnImpl = spawn, timeoutMs = 20_000 } = {}) {
  const live = await endpoint({ p, debugPort });
  if (live) return { started: false, url: live };
  if (await liveBrowser(debugPort)) {
    throw new Error(`Port ${debugPort} is already used by a browser agent-chrome did not start. ` +
      'Close it (or the old agent Chrome window), or set AGENT_CHROME_PORT.');
  }
  mkdirSync(p.profile, { recursive: true });
  const firstRun = !existsSync(join(p.profile, 'Local State'));
  const bin = findChrome(env);
  const child = spawnImpl(bin, [...chromeArgs(p.profile, debugPort), firstRun ? 'about:blank' : ''].filter(Boolean),
    { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref?.();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== 0) throw new Error(`Chrome exited with code ${child.exitCode}.`);
    const url = await liveBrowser(debugPort).catch(() => null);
    if (url) {
      writeRecord(p, { port: debugPort, browserPath: new URL(url).pathname, pid: child.pid, startedAt: new Date().toISOString() });
      return { started: true, url, firstRun };
    }
    await sleep(250);
  }
  throw new Error(`Agent Chrome did not expose DevTools on 127.0.0.1:${debugPort} within ${timeoutMs / 1000}s. ` +
    'Is the port in use by another program?');
}

export async function connect({ p = defaultPaths(), debugPort = defaultPort() } = {}) {
  const url = await endpoint({ p, debugPort });
  if (!url) throw new NotRunningError('Agent Chrome is not running. Ask the user, then run `agent-chrome start`.');
  return new CdpClient(await connectWebSocket(url));
}

/** Gracefully close the agent browser (all its windows). */
export async function stop({ p = defaultPaths(), debugPort = defaultPort() } = {}) {
  const url = await endpoint({ p, debugPort });
  if (!url) return false;
  const cdp = new CdpClient(await connectWebSocket(url));
  try { await cdp.send('Browser.close', {}, undefined, { timeoutMs: 5000 }); } catch {}
  cdp.close();
  return true;
}
