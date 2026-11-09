import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { currentVars, references, expandIncludes, isAgentDirFile, duplicateIndexes, MAX_BYTES } from '../extensions/lib/context-include.ts';

const root = process.env.PI_PACKAGE_ROOT;

const fixture = t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-includes-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('os and host placeholders', () => {
  assert.deepEqual(currentVars('win32', 'DESKTOP-1.lan'), { os: 'windows', host: 'desktop-1' });
  assert.equal(currentVars('darwin', 'macbook').os, 'mac');
  assert.equal(currentVars('linux', 'laptop').os, 'linux');
});

test('references: own line only, list markers ok, code fences and inline mentions ignored', () => {
  const refs = references([
    '@machines/{os}.md', '- @a.md', '1. @b.md', 'see @c.md for more', '@not-markdown.txt',
    '```', '@fenced.md', '```', '@a.md',
  ].join('\n'));
  assert.deepEqual(refs, ['machines/{os}.md', 'a.md', 'b.md']);
});

test('expands recursively, relative to the real folder, once per file, skipping missing', t => {
  const repo = fixture(t);
  mkdirSync(join(repo, 'machines'));
  writeFileSync(join(repo, 'AGENTS.md'), '# shared\n@machines/{os}.md\n@machines/{host}.md\n');
  writeFileSync(join(repo, 'machines', 'linux.md'), 'linux facts\n@common.md\n');
  writeFileSync(join(repo, 'machines', 'common.md'), 'common\n@../AGENTS.md\n@linux.md\n');
  const agentDir = join(repo, 'agent'); mkdirSync(agentDir);
  let linked = join(agentDir, 'AGENTS.md');
  try { symlinkSync(join(repo, 'AGENTS.md'), linked); } catch { linked = join(repo, 'AGENTS.md'); } // Windows without symlink rights
  const r = expandIncludes([{ path: linked, content: '# shared\n@machines/{os}.md\n@machines/{host}.md\n' }], { os: 'linux', host: 'laptop' });
  assert.deepEqual(r.included.map(f => f.content), ['linux facts\n@common.md', 'common\n@../AGENTS.md\n@linux.md']);
  assert.equal(r.missing.length, 1);
  assert.match(r.missing[0], /laptop\.md$/);
});

test('size cap and depth cap', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'big.md'), 'x'.repeat(MAX_BYTES + 1));
  for (let i = 0; i < 8; i++) writeFileSync(join(dir, `d${i}.md`), `level ${i}\n@d${i + 1}.md\n`);
  const big = expandIncludes([{ path: join(dir, 'AGENTS.md'), content: '@big.md' }], { os: 'linux', host: 'h' });
  assert.equal(big.included.length, 0);
  assert.match(big.skipped[0], /over/);
  const deep = expandIncludes([{ path: join(dir, 'AGENTS.md'), content: '@d0.md' }], { os: 'linux', host: 'h' });
  assert.equal(deep.included.length, 5);
  assert.match(deep.skipped[0], /deeper/);
});

test('native: real loader and prompt builder put the include right after AGENTS.md, stable across turns', { skip: !root }, async t => {
  const agentDir = fixture(t);
  mkdirSync(join(agentDir, 'machines'));
  writeFileSync(join(agentDir, 'machines', `${currentVars().os}.md`), 'OS-SPECIFIC RULE');
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev; });
  const imp = p => import(pathToFileURL(resolve(root, p)).href);
  const [{ loadExtensions }, { normalizeBuildSystemPromptOptions, buildSystemPromptSections }] =
    await Promise.all([imp('dist/core/extensions/loader.js'), imp('dist/core/system-prompt.js')]);
  const result = await loadExtensions([resolve('extensions/pi-includes.ts')], process.cwd());
  assert.deepEqual(result.errors, []);
  const [ext] = result.extensions;
  assert.ok(ext.commands.has('includes'));
  const base = { cwd: '/w', contextFiles: [
    { path: join(agentDir, 'AGENTS.md'), content: 'shared\n@machines/{os}.md\n@machines/{host}.md' },
    { path: '/w/project/AGENTS.md', content: 'project\n@machines/{os}.md' }] };
  const turn = async () => {
    const opts = normalizeBuildSystemPromptOptions(base);
    for (const fn of ext.handlers.get('before_agent_start')) await fn({ type: 'before_agent_start', systemPromptOptions: opts }, {});
    return buildSystemPromptSections(opts).project_context;
  };
  const first = await turn();
  assert.deepEqual([...first.matchAll(/path="([^"]+)"/g)].map(m => m[1].replaceAll('\\', '/').split('/').slice(-2).join('/')),
    [`${agentDir.replaceAll('\\', '/').split('/').at(-1)}/AGENTS.md`, `machines/${currentVars().os}.md`, 'project/AGENTS.md']);
  assert.match(first, /OS-SPECIFIC RULE/);
  assert.equal(await turn(), first, 'identical every turn (cache-stable)');
});

test('duplicate context files (same real file) are found, first copy kept', t => {
  const dir = fixture(t);
  const repo = join(dir, 'repo'); mkdirSync(repo);
  writeFileSync(join(repo, 'AGENTS.md'), 'shared');
  const agentDir = join(dir, 'agent'); mkdirSync(agentDir);
  let linked = join(agentDir, 'AGENTS.md');
  try { symlinkSync(join(repo, 'AGENTS.md'), linked); } catch { linked = join(repo, 'AGENTS.md'); }
  const files = [{ path: linked }, { path: join(dir, 'other.md') }, { path: join(repo, 'AGENTS.md') }];
  assert.deepEqual(duplicateIndexes(files), [2]);
  assert.deepEqual(duplicateIndexes([{ path: join(repo, 'AGENTS.md') }, { path: join(dir, 'other.md') }]), []);
});

test('native: the repo copy of a linked global AGENTS.md is dropped from the prompt', { skip: !root }, async t => {
  const dir = fixture(t);
  const repo = join(dir, 'repo'); mkdirSync(repo);
  writeFileSync(join(repo, 'AGENTS.md'), 'shared');
  const agentDir = join(dir, 'agent'); mkdirSync(agentDir);
  const linked = join(agentDir, 'AGENTS.md');
  try { symlinkSync(join(repo, 'AGENTS.md'), linked); } catch { t.skip('no symlink rights'); return; }
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev; });
  const { loadExtensions } = await import(pathToFileURL(resolve(root, 'dist/core/extensions/loader.js')).href);
  const [ext] = (await loadExtensions([resolve('extensions/pi-includes.ts')], process.cwd())).extensions;
  const opts = { contextFiles: [{ path: linked, content: 'shared' }, { path: join(repo, 'AGENTS.md'), content: 'shared' }] };
  for (const fn of ext.handlers.get('before_agent_start')) await fn({ type: 'before_agent_start', systemPromptOptions: opts }, {});
  assert.deepEqual(opts.contextFiles.map(f => f.path), [linked]);
});

test('only the agent-dir AGENTS.md expands', () => {
  assert.equal(isAgentDirFile('/home/k/.pi/agent/AGENTS.md', '/home/k/.pi/agent'), true);
  assert.equal(isAgentDirFile('C:\\Users\\K\\.pi\\agent\\AGENTS.md', 'c:\\users\\k\\.pi\\agent'), process.platform === 'win32');
  assert.equal(isAgentDirFile('/home/k/projects/x/AGENTS.md', '/home/k/.pi/agent'), false);
});
