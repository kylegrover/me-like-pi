#!/usr/bin/env node
// One command for tests + typecheck with compact output (saves agent tokens).
// Usage: node scripts/check.mjs [test|types|links] [--verbose]   (default: all)
// Pi root: $PI_PACKAGE_ROOT, else the newest ~/.pi/agent/install/releases/<v>.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const only = args.find(a => !a.startsWith('--'));

function piRoot() {
  if (process.env.PI_PACKAGE_ROOT) return process.env.PI_PACKAGE_ROOT;
  const releases = join(homedir(), '.pi/agent/install/releases');
  const newest = readdirSync(releases).filter(v => /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  if (!newest) throw new Error(`No Pi release under ${releases}; set PI_PACKAGE_ROOT.`);
  return join(releases, newest, 'node_modules/@earendil-works/pi-coding-agent');
}

const root = piRoot().replaceAll('\\', '/');
const modules = resolve(root, '../..').replaceAll('\\', '/');
const run = (cmd, argv, env = {}) => spawnSync(cmd, argv, { cwd: repo, encoding: 'utf8', shell: process.platform === 'win32',
  env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
let failed = false;

if (!only || only === 'test') {
  const files = readdirSync(join(repo, 'tests')).filter(f => f.endsWith('.test.mjs')).map(f => `tests/${f}`);
  const r = run(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', ...files], { PI_PACKAGE_ROOT: root });
  const out = r.stdout + r.stderr;
  const count = k => out.match(new RegExp(`^# ${k} (\\d+)`, 'm'))?.[1] ?? '?';
  console.log(`tests: ${count('pass')} pass, ${count('fail')} fail, ${count('skipped')} skipped`);
  if (r.status !== 0 || verbose) {
    failed ||= r.status !== 0;
    // Failing subtests with their error blocks only, not the whole TAP stream.
    const lines = out.split('\n'); let keep = 0;
    for (const line of lines) {
      if (/^\s*not ok /.test(line)) keep = 40;
      if (keep-- > 0 || verbose) console.log(line);
    }
  }
}

if (!only || only === 'types') {
  const dir = mkdtempSync(join(tmpdir(), 'pi-config-tsc-'));
  const d = name => `${modules}/@earendil-works/${name}/dist/index.d.ts`;
  const tsconfig = {
    compilerOptions: { target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', allowImportingTsExtensions: true,
      strict: true, noEmit: true, skipLibCheck: true, verbatimModuleSyntax: true, types: ['node'], typeRoots: [`${modules}/@types`],
      paths: { '@earendil-works/pi-ai': [d('pi-ai')], '@earendil-works/pi-ai/*': [`${modules}/@earendil-works/pi-ai/dist/*.d.ts`],
        '@earendil-works/pi-agent-core': [d('pi-agent-core')], '@earendil-works/pi-tui': [d('pi-tui')],
        '@earendil-works/pi-coding-agent': [d('pi-coding-agent')],
        '@sinclair/typebox': [`${modules}/typebox/build/index.d.mts`], typebox: [`${modules}/typebox/build/index.d.mts`] } },
    include: [`${repo.replaceAll('\\', '/')}/extensions/**/*.ts`],
  };
  const file = join(dir, 'tsconfig.json');
  writeFileSync(file, JSON.stringify(tsconfig));
  let r = run('npm', ['exec', '--offline', '--yes', '--package=typescript', '--', 'tsc', '--project', file]);
  // TypeScript not in the npm cache (offline): use a tsc on PATH instead, if there is one.
  if (r.status !== 0 && /ENOTCACHED/.test(r.stdout + r.stderr)) {
    const local = run('tsc', ['--project', file]);
    if (!local.error && !/not (found|recognized)/i.test(local.stderr)) r = local;
    // Pi doesn't ship TypeScript, so there's nothing else to fall back to.
    else { console.log('types: skipped. TypeScript is not in the npm cache and no tsc is on PATH. Fix: run once online, or `npm i -g typescript`.'); r = { ...r, status: 0, skipped: true }; }
  }
  const errors = (r.stdout + r.stderr).split('\n').filter(l => /error TS\d+/.test(l));
  if (!r.skipped) console.log(`types: ${r.status === 0 ? 'clean' : `${errors.length || 'unknown'} error(s)`}`);
  if (r.status !== 0) { failed = true; console.log((errors.length ? errors : [(r.stdout + r.stderr).trim()]).slice(0, 30).join('\n')); }
}

if (!only || only === 'links') {
  // Relative Markdown links in tracked docs must resolve (http/mailto/anchors-only skipped).
  // share/public/ is laid out for the public repo, so its links are checked there instead.
  const tracked = run('git', ['ls-files', '*.md']).stdout.split('\n').filter(f => f && !f.startsWith('share/public/'));
  const broken = [];
  for (const file of tracked) {
    const text = readFileSync(join(repo, file), 'utf8');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const path = decodeURIComponent(target.split('#')[0]);
      if (!existsSync(resolve(repo, dirname(file), path))) broken.push(`${file}: ${target}`);
    }
  }
  console.log(`links: ${broken.length ? `${broken.length} broken` : 'ok'} (${tracked.length} files)`);
  if (broken.length) { failed = true; console.log(broken.join('\n')); }
}

process.exit(failed ? 1 : 0);
