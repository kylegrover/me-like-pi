// Only the SDK/session implementation is native here. Model work is scripted and
// auth/runtime are stubs: no credential loading, providers, discovery or network.
import { syntheticAssistant, syntheticTools } from '../../scripts/lib/delegation-context-spike.mjs';

export async function sdkWorker(n, manager, { replies = [], extensions = [], customTools } = {}) {
  const [{ createAgentSession }, { SettingsManager }, { createExtensionRuntime }, { AssistantMessageEventStream }] =
    await Promise.all([n.native('dist/core/sdk.js'), n.native('dist/core/settings-manager.js'),
      n.native('dist/core/extensions/loader.js'), n.ai('utils/event-stream.js')]);
  const model = n.models[0], requests = [];
  let executions = 0;
  const runtime = {
    getModel: () => model,
    getPhysicalModel: () => model,
    hasConfiguredAuth: () => true,
    isUsingOAuth: () => false,
    getAvailableSnapshot: () => [model],
    async streamSimple(selected, context, options) {
      requests.push({ model: selected, context: structuredClone(context),
        sessionId: options.sessionId, reasoning: options.reasoning });
      const response = replies.shift() ?? syntheticAssistant(model, [{ type: 'text', text: 'Synthetic receipt.' }]);
      const stream = new AssistantMessageEventStream();
      stream.push({ type: 'done', reason: response.stopReason, message: response });
      stream.end();
      return stream;
    },
  };
  const resourceLoader = {
    getExtensions: () => ({ extensions, errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error('Resource discovery forbidden'); },
    reload: async () => { throw new Error('Reload discovery forbidden'); },
  };
  const tools = customTools ?? syntheticTools().map(tool => ({ ...tool, label: tool.name,
    execute: async () => { executions++; return { content: [{ type: 'text', text: 'scripted tool result' }], details: undefined }; } }));
  const { session } = await createAgentSession({ cwd: process.cwd(), model, thinkingLevel: 'medium',
    modelRuntime: runtime, sessionManager: manager, resourceLoader,
    tools: tools.map(t => t.name), customTools: tools,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false },
      retry: { enabled: false }, cacheWarming: 'off' }),
  });
  return { session, requests, executions: () => executions };
}

// Minimal synthetic Extension object in the same shape produced by Pi's loader.
export function syntheticExtension(handlers) {
  return { path: '<s1-synthetic>', resolvedPath: '<s1-synthetic>',
    handlers: new Map(Object.entries(handlers).map(([name, handler]) => [name, [handler]])),
    tools: new Map(), commands: new Map(), shortcuts: new Map(), flags: new Map(),
    messageRenderers: new Map() };
}
