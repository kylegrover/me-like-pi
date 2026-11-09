import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { piDependency } from './helpers/pi-package.mjs';
import { findTranscript, ReadFromTop } from '../extensions/lib/read-from-top.ts';

const root = process.env.PI_PACKAGE_ROOT;
const VIEW = 10;

// Real pi-tui Containers and ScrollView inside Pi's real fullscreen chat viewport,
// shaped like interactive mode: document = [header, resources, chat].
async function real() {
  const tui = await import(pathToFileURL(piDependency(root, '@earendil-works/pi-tui', 'dist/index.js')).href);
  const { createChatViewport } = await import(pathToFileURL(resolve(root, 'dist/modes/interactive/chat-viewport.js')).href);
  const blank = () => new tui.Container();
  const block = n => ({ n, render() { return Array(this.n).fill('x'); }, invalidate() {} });
  const header = blank(); header.addChild(block(3));
  const chat = blank();
  const doc = blank(); doc.addChild(header); doc.addChild(blank()); doc.addChild(chat);
  const viewport = createChatViewport({ document: doc, pendingMessages: blank(), status: blank(), editor: blank(), footer: blank() });
  const sv = viewport.transcript;
  // One layout pass, as pi-tui does it: render the document, then updateLayout.
  const frame = () => sv.updateLayout(doc.render(80).length, VIEW, () => {});
  const add = n => { const b = block(n); chat.addChild(b); return b; };
  return { sv, chat, add, frame, layoutRoot: viewport.root };
}

test('native: finds the transcript under the fullscreen layout root', { skip: !root }, async () => {
  const { sv, layoutRoot } = await real();
  assert.equal(findTranscript({ layoutRoot }), sv);
  assert.equal(findTranscript({}), undefined, 'regular mode has no layout root');
});

test('native: pins the reply, not the user message, even when both arrive before a render', { skip: !root }, async () => {
  const { sv, add, frame } = await real();
  const r = new ReadFromTop(sv);
  add(20); frame();                // earlier history (3 header + 20)
  add(6);                          // user message added, not rendered yet
  r.start();                       // assistant message_start fires before the next render
  const reply = add(2); frame();   // reply component added; first render
  assert.equal(sv.isFollowingEnd, true, 'reply still short: following');
  reply.n = 40; frame();
  assert.equal(sv.scrollTop, 29, 'reply first line (3 + 20 + 6) on the top row');
  assert.equal(sv.isFollowingEnd, false);
  reply.n = 80; frame();
  assert.equal(sv.scrollTop, 29, 'stays put while the reply streams');
  sv.scrollBy(1000); reply.n = 90; frame();
  assert.equal(sv.scrollTop, 3 + 20 + 6 + 90 - VIEW, 'scrolled to the end: follows again, no snap back');
  r.end();
});

test('native: no freeze when the user already scrolled up, or when the reply fits', { skip: !root }, async () => {
  const { sv, add, frame } = await real();
  const r = new ReadFromTop(sv);
  add(30); frame();
  sv.scrollBy(-10);
  r.start(); const reply = add(5); frame(); reply.n = 30; frame();
  assert.equal(sv.scrollTop, 13, 'left where the user put it');
  r.end();
  sv.scrollBy(1000); r.start(); add(3); frame(); r.end(); add(40); frame();
  assert.equal(sv.isFollowingEnd, true, 'later output (e.g. a tool result) still follows');
});

test('native: reload reuses one patch and the newest handler', { skip: !root }, async () => {
  const { sv, add, frame } = await real();
  const first = new ReadFromTop(sv);
  const patched = sv.updateLayout;
  first.dispose();
  const second = new ReadFromTop(sv);
  assert.equal(sv.updateLayout, patched, 'not double-wrapped');
  add(20); frame(); second.start(); const reply = add(1); frame(); reply.n = 15; frame();
  assert.equal(sv.scrollTop, 23);
});

// Pi's real AssistantMessageComponent inside the real viewport: thinking then answer text.
async function realReply() {
  const env = await real();
  const { initTheme } = await import(pathToFileURL(resolve(root, 'dist/modes/interactive/theme/theme.js')).href);
  initTheme('dark');
  const { AssistantMessageComponent } = await import(pathToFileURL(resolve(root, 'dist/modes/interactive/components/assistant-message.js')).href);
  const lines = n => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n\n');
  const message = (thinking, text) => ({ role: 'assistant', content: [
    ...(thinking ? [{ type: 'thinking', thinking }] : []), ...(text ? [{ type: 'text', text }] : [])] });
  return { ...env, AssistantMessageComponent, lines, message };
}

for (const hidden of [false, true]) {
  test(`native: skips ${hidden ? 'the collapsed "Thinking..." label' : 'expanded thinking'} and pins the first answer line`, { skip: !root }, async () => {
    const { sv, chat, add, frame, AssistantMessageComponent, lines, message } = await realReply();
    const r = new ReadFromTop(sv); // skipThinking defaults to on
    add(20); frame();
    r.start();
    const reply = new AssistantMessageComponent(undefined, hidden);
    chat.addChild(reply);
    reply.updateContent(message(lines(30), ''), true); frame();
    assert.equal(sv.isFollowingEnd, true, 'only thinking so far: keeps following');
    reply.updateContent(message(lines(30), lines(40)), true); frame();
    const content = reply.children[0].mouseLayout.children;
    const thinkingRows = content[0].height + content[1].height + content[2].height; // spacer, thinking run, spacer
    assert.equal(sv.scrollTop, 3 + 20 + thinkingRows, 'pinned on the answer, past the thinking');
    assert.ok(hidden ? thinkingRows === 3 : thinkingRows > 30, `thinking rows: ${thinkingRows}`);
    r.end();
  });
}

test('native: with skipThinking off, the pin is the top of the reply (thinking included)', { skip: !root }, async () => {
  const { sv, chat, add, frame, AssistantMessageComponent, lines, message } = await realReply();
  const r = new ReadFromTop(sv, { skipThinking: false });
  add(20); frame();
  r.start();
  const reply = new AssistantMessageComponent(undefined, false);
  chat.addChild(reply);
  reply.updateContent(message(lines(30), lines(40)), true); frame();
  assert.equal(sv.scrollTop, 3 + 20);
  r.end();
});
