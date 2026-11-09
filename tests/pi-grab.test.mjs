import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Replace only the clipboard import; everything else is the unmodified source.
const source = readFileSync(new URL('../extensions/pi-grab.ts', import.meta.url), 'utf8');
const piImport = 'import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";';
const tuiImport = 'import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";';
assert.ok(source.includes(piImport) && source.includes(tuiImport));
const js = stripTypeScriptTypes(source.replace(piImport,
  'const copyToClipboard = async text => { globalThis.__grabCopied.push(text); };').replace(tuiImport,
  'const Key = { left: "left", right: "right" }; const matchesKey = (d, k) => d === k; const truncateToWidth = s => s;'));
const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const { collect, resolve, workerReport, splitParts, createNavigator } = mod;

const msg = (role, content, extra = {}) => ({ type: 'message', message: { role, content, ...extra } });

function harness(branch, choose = labels => labels[0]) {
  globalThis.__grabCopied = [];
  const commands = new Map(), notices = [], picks = [];
  mod.default({ registerCommand: (name, opts) => commands.set(name, opts) });
  const ctx = { hasUI: true, mode: 'rpc', sessionManager: { getBranch: () => branch },
    ui: { notify: (...a) => notices.push(a), select: async (title, labels) => { picks.push(labels); return choose(labels); } } };
  return { run: args => commands.get('grab').handler(args, ctx), copied: globalThis.__grabCopied, notices, picks, commands };
}

const branch = [
  msg('user', 'first prompt'),
  msg('assistant', [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'reply one' }]),
  msg('assistant', [{ type: 'toolCall', id: 't', name: 'bash', arguments: {} }]),
  msg('toolResult', [{ type: 'text', text: 'tool output' }], { toolName: 'bash' }),
  msg('assistant', [{ type: 'text', text: 'reply two' }]),
  { type: 'custom', customType: 'pi-cache-observability', data: {} },
  msg('user', [{ type: 'text', text: 'second prompt' }]),
  msg('assistant', [{ type: 'text', text: 'reply three' }]),
];

test('collect keeps text only, skips thinking/tool calls/custom entries', () => {
  const items = collect(branch);
  assert.deepEqual(items.map(i => [i.kind, i.text]), [
    ['user', 'first prompt'], ['assistant', 'reply one'], ['tool', 'tool output'],
    ['assistant', 'reply two'], ['user', 'second prompt'], ['assistant', 'reply three']]);
  assert.ok(!items.some(i => i.text.includes('secret')));
});

test('resolve: user, tool, N replies, errors', () => {
  const items = collect(branch);
  assert.deepEqual(resolve(items, 'user'), { text: 'second prompt', what: 'prompt' });
  assert.deepEqual(resolve(items, 'tool'), { text: 'tool output', what: 'tool result' });
  assert.equal(resolve(items, '2').text, 'reply two\n\n---\n\nreply three');
  assert.equal(resolve(items, '99').what, '3 replies');
  assert.match(resolve(items, 'do').error, /No \/do result/);
  assert.match(resolve(items, '0').error, /Usage/);
  assert.match(resolve(items, 'nope').error, /Usage/);
});

test('/do: full report recovered from worker session when truncated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-grab-'));
  try {
    const file = join(dir, 'worker.jsonl');
    const full = 'FULL REPORT ' + 'x'.repeat(5000);
    writeFileSync(file, [
      { type: 'session' },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'earlier' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: full }] } },
      { type: 'custom', customType: 'x' },
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
    assert.equal(workerReport(file), full);
    assert.equal(workerReport(join(dir, 'missing.jsonl')), undefined);
    const truncated = { type: 'custom_message', customType: 'delegate-result', details: { sessionFile: file },
      content: `[/do worker result] Task: look\n\nFULL REPORT xxx\n[Report truncated; full text is in the worker session.]\n\nWorker session: ${file}` };
    const r = resolve(collect([truncated]), 'do');
    assert.equal(r.text, `[/do worker result] Task: look\n\n${full}\n\nWorker session: ${file}`);
    // Untruncated results are copied as stored; a missing session file falls back to the stored text.
    const plain = { ...truncated, content: 'short report' };
    assert.equal(resolve(collect([plain]), 'do').text, 'short report');
    const gone = { ...truncated, details: { sessionFile: join(dir, 'gone.jsonl') } };
    assert.match(resolve(collect([gone]), 'do').text, /Report truncated/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('command: argument copies, picker is newest first, cancel copies nothing', async () => {
  let h = harness(branch);
  await h.run('2');
  assert.deepEqual(h.copied, ['reply two\n\n---\n\nreply three']);
  assert.match(h.notices[0][0], /Copied 2 replies/);

  h = harness(branch, labels => labels[2]);
  await h.run('');
  assert.match(h.picks[0][0], /reply\s+reply three/);
  assert.equal(h.picks[0].length, 6);
  assert.deepEqual(h.copied, ['reply two']);

  h = harness(branch, () => undefined);
  await h.run('');
  assert.deepEqual(h.copied, []);

  h = harness([]);
  await h.run('do');
  assert.deepEqual(h.copied, []);
  assert.equal(h.notices[0][1], 'warning');

  assert.deepEqual(h.commands.get('grab').getArgumentCompletions('t').map(c => c.value), ['tool']);
});

const reply = [
  'Intro paragraph line one,',
  'still the same paragraph.',
  '',
  '## Heading',
  'Second paragraph.',
  '',
  '> Quoted handoff line one',
  '> line two',
  '',
  '- item a',
  '  continued a',
  '- item b',
  '',
  '```bash',
  'echo hi',
  '',
  'echo after blank',
  '```',
  '',
  '| a | b |',
  '|---|---|',
  '',
  '~~~',
  'tilde code with ``` inside',
  '~~~',
].join('\n');

test('splitParts: paragraphs, heading, quote without markers, list, fenced code, table', () => {
  const parts = splitParts(reply);
  assert.deepEqual(parts.map(p => p.label), ['paragraph', 'heading', 'paragraph', 'quote', 'list', 'code bash', 'table', 'code']);
  assert.equal(parts[0].text, 'Intro paragraph line one,\nstill the same paragraph.');
  assert.equal(parts[3].text, 'Quoted handoff line one\nline two');
  assert.equal(parts[4].text, '- item a\n  continued a\n- item b');
  assert.equal(parts[5].text, 'echo hi\n\necho after blank');
  assert.equal(parts[7].text, 'tilde code with ``` inside');
  assert.deepEqual(splitParts('just one line').map(p => p.text), ['just one line']);
  // Unclosed fence runs to the end rather than dropping text.
  assert.equal(splitParts('```\nopen').at(-1).text, 'open');
});

test('navigator: starts newest, up/right/down/enter copies one part, left goes back', () => {
  const items = collect([msg('assistant', [{ type: 'text', text: reply }]), msg('user', 'later prompt')]);
  const nav = createNavigator(items);
  assert.equal(nav.current().text, 'later prompt');
  assert.equal(nav.press('right'), undefined);
  assert.equal(nav.state.level, 0); // single-part item: right does nothing
  nav.press('up');
  nav.press('up'); // clamps at the top
  nav.press('right');
  assert.equal(nav.state.level, 1);
  for (let i = 0; i < 5; i++) nav.press('down');
  assert.deepEqual(nav.press('enter'), { text: 'echo hi\n\necho after blank', what: 'code bash from reply' });
  nav.press('left');
  assert.equal(nav.state.level, 0);
  assert.deepEqual(nav.press('enter'), { text: reply, what: 'reply' });
  assert.equal(nav.press('escape'), null);
});

test('command uses the custom browser in TUI mode', async () => {
  globalThis.__grabCopied = [];
  const commands = new Map(), notices = [];
  mod.default({ registerCommand: (name, opts) => commands.set(name, opts) });
  let rendered;
  const ctx = { hasUI: true, mode: 'tui', sessionManager: { getBranch: () => branch },
    ui: { notify: (...a) => notices.push(a), custom: async (factory, options) => {
      assert.equal(options.blocked.kind, 'question');
      let result;
      const theme = { fg: (_c, t) => t, bold: t => t };
      const keybindings = { matches: (d, k) => d === k };
      const component = factory({ requestRender() {} }, theme, keybindings, r => { result = r; });
      rendered = component.render(80);
      component.handleInput('tui.select.up');
      component.handleInput('tui.select.confirm');
      return result;
    } } };
  await commands.get('grab').handler('', ctx);
  assert.match(rendered.join('\n'), /> reply\s+reply three/);
  // Preview sits above the list.
  assert.ok(rendered.indexOf('reply three') < rendered.findIndex(l => /> reply/.test(l)));
  assert.deepEqual(globalThis.__grabCopied, ['second prompt']);
});

test('browser height stays fixed while moving between items and into parts', async () => {
  const items = [msg('assistant', [{ type: 'text', text: reply }]), msg('user', 'one line'), msg('assistant', [{ type: 'text', text: 'a\nb\nc\nd\ne\nf\ng\nh' }])];
  mod.default({ registerCommand: (name, opts) => (globalThis.__grabCmd = opts) });
  const heights = [];
  const ctx = { hasUI: true, mode: 'tui', sessionManager: { getBranch: () => items },
    ui: { notify() {}, custom: async factory => {
      const c = factory({ requestRender() {} }, { fg: (_c, t) => t, bold: t => t }, { matches: (d, k) => d === k }, () => {});
      heights.push(c.render(80).length);
      for (const key of ['tui.select.up', 'tui.select.up', 'right', 'tui.select.down', 'tui.select.down', 'left']) {
        c.handleInput(key); heights.push(c.render(80).length);
      }
      return null;
    } } };
  await globalThis.__grabCmd.handler('', ctx);
  assert.equal(new Set(heights).size, 1, `heights varied: ${heights}`);
});
