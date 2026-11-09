import sprint from '../../extensions/pi-sprint.ts';

export function handoffHarness({ sm: nativeSm, navigate: nativeNavigate } = {}) {
  const commands = new Map(), tools = new Map(), handlers = new Map();
  const sent = [], notices = [], models = [], thinkingChanges = [], gitCalls = [], summaries = [];
  let id = 0, leaf = null, entries = [], thinking = 'medium', idle = true, pending = false;
  let model = { provider: 'openai-codex', id: 'gpt-6-astra', api: 'openai-codex-responses' };
  const controls = { gitError: false, setModelError: false, treeCancel: false, treeTamper: false, thinkingClamp: false,
    missingModel: false, modelThinking: undefined, gitDelay: undefined, modelDelay: undefined, treeDelay: undefined };
  controls.available = ['openai-codex/gpt-6-astra', 'openai-codex/gpt-6-sol', 'openai-codex/gpt-6.1-sol',
    'openai-codex/gpt-6.1-terra', 'openai-codex/gpt-6-luna', 'openai/gpt-6.1-terra',
    'claude-code/claude-opus-5-5', 'claude-code/claude-sonnet-5', 'claude-code/claude-sonnet-5-5',
    'claude-code/claude-haiku-5-5', 'claude-code/default'];
  const catalogModel = (provider, id) => ({ provider, id,
    api: provider === 'claude-code' ? 'claude-code-stream-json'
      : provider === 'anthropic' ? 'anthropic-messages' : 'openai-codex-responses' });
  const append = (e) => { const row = { ...structuredClone(e), id: String(++id), parentId: leaf }; entries.push(row); leaf = row.id; return row.id; };
  const sm = nativeSm ?? {
    getSessionId: () => 'test-session', getSessionFile: () => '/local/test-session.jsonl', getLeafId: () => leaf,
    getEntries: () => entries, getEntry: id => entries.find(e => e.id === id),
    getBranch(from = leaf) {
      const result = [];
      while (from) { const e = this.getEntry(from); if (!e) break; result.unshift(e); from = e.parentId; }
      return result;
    },
    appendCustomEntry: (type, data) => append({ type: 'custom', customType: type, data }),
    appendMessage: message => append({ type: 'message', message }),
    appendLabelChange: (targetId, label) => append({ type: 'label', targetId, label }),
    branchWithSummary(targetId, summary, details) {
      const fromId = leaf; leaf = targetId;
      return append({ type: 'branch_summary', summary, details, fromId });
    },
    buildContextEntries() { return this.getBranch(); },
  };
  const ctx = {
    hasUI: true, cwd: process.cwd(), get model() { return model; }, sessionManager: sm,
    isIdle: () => idle, hasPendingMessages: () => pending,
    modelRegistry: {
      find: (provider, id) => controls.missingModel ? undefined : catalogModel(provider, id),
      getAvailable: () => controls.missingModel ? [] : controls.available.map(ref => catalogModel(...ref.split('/'))),
    },
    ui: { notify: text => notices.push(text), setStatus() {} },
    abort() {},
    compact() { throw new Error('Unexpected compaction'); },
    async navigateTree(targetId, options) {
      if (controls.treeDelay) await controls.treeDelay;
      if (nativeNavigate) return nativeNavigate({ targetId, options, sm, emit, controls, ctx });
      const preparation = { targetId, oldLeafId: sm.getLeafId(), userWantsSummary: options.summarize,
        customInstructions: options.customInstructions };
      const result = await emit('session_before_tree', { preparation, signal: new AbortController().signal });
      if (controls.treeCancel || result?.cancel) return { cancelled: true };
      if (!result?.summary) throw new Error('Would invoke an unwanted native summarizer');
      const summary = controls.treeTamper ? 'wrong packet' : result.summary.summary;
      summaries.push(summary);
      sm.branchWithSummary(targetId, summary, result.summary.details);
      await emit('session_tree', {});
      return { cancelled: false };
    },
  };
  async function emit(name, event = {}) {
    let result;
    for (const fn of handlers.get(name) ?? []) {
      const r = await fn(event, ctx);
      if (r) result = { ...result, ...r };
    }
    return result;
  }
  const pi = {
    on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    registerCommand: (name, def) => commands.set(name, def), registerTool: def => tools.set(def.name, def),
    appendEntry: (type, data) => sm.appendCustomEntry(type, structuredClone(data)),
    setLabel: (target, label) => sm.appendLabelChange(target, label),
    getThinkingLevel: () => thinking,
    setThinkingLevel(value) { thinkingChanges.push(value); thinking = controls.thinkingClamp ? 'high' : value; void emit('thinking_level_select', { level: thinking }); },
    async setModel(value) {
      if (controls.modelDelay) await controls.modelDelay;
      if (controls.setModelError) return false;
      model = value; models.push(value.id);
      if (controls.modelThinking !== undefined) thinking = controls.modelThinking;
      await emit('model_select', { model: value }); return true;
    },
    sendUserMessage: text => { sent.push(text); },
    sendMessage() { throw new Error('Unexpected custom message'); },
    async exec(command, args, options) {
      gitCalls.push({ command, args, options });
      if (controls.gitDelay) await controls.gitDelay;
      if (controls.gitError) return { code: 128, stderr: 'not a repo', stdout: '', killed: false };
      return { code: 0, stderr: '', killed: false, stdout: args.includes('--show-toplevel') ? '/repo\n'
        : args.includes('HEAD') ? 'abc123\n' : '## main\n M user-owned.txt\n' };
    },
  };
  const install = () => { handlers.clear(); commands.clear(); tools.clear(); sprint(pi); };
  install();
  const command = (name, args = '') => commands.get(name).handler(args, ctx);
  const saved = () => sm.getEntries().filter(e => e.type === 'custom' && e.customType === 'pi-handoff').at(-1)?.data;
  const start = async (args = 'Change only example.txt; validate, then stop.') => { await command('handoff', args); };
  function answer({ ready = true, stopReason = 'stop', thinkingBlock = false } = {}) {
    const marker = sent.at(-1).match(/<!-- pi-handback-ready:[^>]+ -->/)?.[0];
    const text = `Completed bounded work. Checks: fixture passed. Uncertainty: live trial pending.\n${ready ? marker : 'Need clarification.'}`;
    const entryId = sm.appendMessage({ role: 'assistant', stopReason, content: [
      ...(thinkingBlock ? [{ type: 'thinking', thinking: 'private reasoning' }] : []), { type: 'text', text },
    ] });
    return { text, entryId };
  }
  async function finish(options) {
    const task = command('handback');
    const original = answer(options);
    await emit('agent_settled'); await task;
    return original;
  }
  return { pi, ctx, sm, controls, command, emit, saved, start, answer, finish, sent, models, thinkingChanges, notices, gitCalls, summaries, tools,
    setIdle: value => { idle = value; }, setPending: value => { pending = value; },
    setModel: value => { model = value; }, setThinking: value => { thinking = value; },
    reload: async () => { await emit('session_shutdown', { reason: 'reload' }); install(); await emit('session_start', { reason: 'reload' }); },
  };
}
