// Paths, Chrome discovery and the local-only endpoint rule. No network access here.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 9333;

/** Home for the dedicated agent profile and tool state. Never the user's normal Chrome profile. */
export function homeDir(env = process.env, platform = process.platform) {
  if (env.AGENT_CHROME_HOME) return env.AGENT_CHROME_HOME;
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'agent-chrome');
  if (platform === 'darwin') return join(homedir(), 'Library/Application Support/agent-chrome');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'agent-chrome');
}

export function paths(env = process.env, platform = process.platform) {
  const home = homeDir(env, platform);
  return {
    home,
    profile: join(home, 'profile'),
    state: join(home, 'state'),
    shots: join(home, 'shots'),
    lock: join(home, 'state', 'browser.lock'),
  };
}

export function port(env = process.env) {
  const raw = env.AGENT_CHROME_PORT;
  if (!raw) return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`AGENT_CHROME_PORT must be 1024-65535, got ${raw}`);
  return n;
}

/** Session names isolate each agent's current/owned tabs inside the one browser. */
export function sessionName(raw) {
  const name = raw || 'default';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(`Invalid session name ${JSON.stringify(name)}: use [A-Za-z0-9_-], up to 64 chars`);
  return name;
}

export function chromeCandidates(env = process.env, platform = process.platform) {
  if (env.AGENT_CHROME_BIN) return [env.AGENT_CHROME_BIN];
  if (platform === 'win32') {
    return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
      .filter(Boolean).map((base) => join(base, 'Google/Chrome/Application/chrome.exe'));
  }
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
}

export function findChrome(env = process.env, platform = process.platform, exists = existsSync) {
  const found = chromeCandidates(env, platform).find((p) => exists(p));
  if (!found) throw new Error('Chrome not found. Set AGENT_CHROME_BIN to the Chrome executable.');
  return found;
}

/** Arguments for the dedicated agent browser. Debugging binds to loopback by default. */
export function chromeArgs(profileDir, debugPort) {
  return [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Refuse anything but a loopback DevTools endpoint: this tool never talks to remote hosts. */
export function assertLoopback(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid DevTools URL: ${url}`); }
  if (!['ws:', 'http:'].includes(parsed.protocol) || !LOOPBACK.has(parsed.hostname)) {
    throw new Error(`Refusing non-local DevTools endpoint ${parsed.protocol}//${parsed.host}`);
  }
  return url;
}

/**
 * The browser endpoint for *our* profile only: Chrome writes DevToolsActivePort into the
 * user-data-dir it is using, so reading it from the agent profile can't select another browser.
 */
export function readActivePort(profileDir, read = readFileSync) {
  let text;
  try { text = read(join(profileDir, 'DevToolsActivePort'), 'utf8'); } catch { return null; }
  const [portLine, pathLine] = text.split(/\r?\n/).map((s) => s.trim());
  const n = Number(portLine);
  if (!Number.isInteger(n) || n <= 0 || !pathLine?.startsWith('/devtools/browser/')) return null;
  return { port: n, url: assertLoopback(`ws://127.0.0.1:${n}${pathLine}`) };
}
