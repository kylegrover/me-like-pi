import type * as Pi from "@earendil-works/pi-coding-agent";
import type { Message, Tool } from "@earendil-works/pi-ai";

export type WorkerToolSDK = Pick<typeof Pi, "DefaultResourceLoader" | "getAgentDir" | "createCodemodeExtension" |
  "createReadToolDefinition" | "createBashToolDefinition" | "createEditToolDefinition" | "createWriteToolDefinition" |
  "createGrepToolDefinition" | "createFindToolDefinition" | "createLsToolDefinition" | "createPowerShellToolDefinition">;

/** Replay declarations, including removals, without flattening the inherited transcript. */
export function inheritedTools(messages: Message[]) {
  const tools = new Map<string, Tool>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return [...tools.values()];
}

/** Independent implementations, not calls back into the waiting parent's tool pipeline. */
export async function workerTools(sdk: WorkerToolSDK, cwd: string, messages: Message[], settingsManager: Pi.SettingsManager,
  toolInfo: Pick<Pi.ToolInfo, "name" | "exposure" | "namespace">[] = []) {
  const declarations = inheritedTools(messages);
  const inherited = new Map(declarations.map(tool => [tool.name, tool]));
  const metadata = new Map(toolInfo.map(tool => [tool.name, tool]));
  const local: Pi.ToolDefinition<any, any>[] = [sdk.createReadToolDefinition(cwd), sdk.createBashToolDefinition(cwd),
    sdk.createEditToolDefinition(cwd), sdk.createWriteToolDefinition(cwd), sdk.createGrepToolDefinition(cwd),
    sdk.createFindToolDefinition(cwd), sdk.createLsToolDefinition(cwd), sdk.createPowerShellToolDefinition(cwd)];
  const implementations = new Map(local.map(tool => [tool.name, tool]));
  const unavailable = declarations.filter(tool => tool.name !== "delegate" && tool.name !== "codemode" &&
    !implementations.has(tool.name)).map(tool => tool.name);
  const sections: Record<string, string> = {};
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) delete sections[name]; else sections[name] = value;
    }
  }
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: sdk.getAgentDir(), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => {
      // Keep the parent's structured instructions rather than replacing them with a
      // newly discovered project context. Preserve original transcript ordering.
      pi.on("before_agent_start", event => {
        if (!sections.preamble) return;
        event.systemPromptOptions.customPrompt = sections.preamble;
        event.systemPromptOptions.sections = Object.fromEntries(Object.entries(sections)
          .filter(([name]) => name !== "preamble" && name !== "cwd")
          .map(([name, value]) => [name, value.startsWith(`<${name}>\n`) && value.endsWith(`\n</${name}>`)
            ? value.slice(name.length + 3, -(name.length + 4)) : value]));
        event.systemPromptOptions.contextFiles = [];
        event.systemPromptOptions.skills = [];
        event.systemPromptOptions.appendSystemPrompt = "";
      });
      for (const declaration of declarations) {
        if (declaration.name === "codemode") continue;
        const implementation = implementations.get(declaration.name);
        pi.registerTool({ ...implementation, ...declaration, parameters: declaration.parameters as Pi.ToolDefinition["parameters"],
          label: implementation?.label ?? declaration.name,
          exposure: declaration.name === "delegate" ? "model-only" : metadata.get(declaration.name)?.exposure ?? "direct",
          namespace: metadata.get(declaration.name)?.namespace,
          execute: declaration.name === "delegate" ? async () => { throw new Error("Nested delegation is disabled in workers."); }
            : implementation?.execute ?? (async () => { throw new Error(`Tool ${declaration.name} is unavailable in this independent worker. Ask the parent to run it.`); }),
        });
      }
      // Register Pi's actual codemode, including its executor, store, argument shim,
      // nested-call pipeline and output schemas. Freeze only model-facing inherited
      // descriptions: reapplying codemode's suffix would redefine read/bash/etc.
      sdk.createCodemodeExtension()(new Proxy(pi, { get(target, key) {
        if (key !== "registerTool") return Reflect.get(target, key);
        return (definition: Pi.ToolDefinition) => target.registerTool({ ...definition,
          ...(inherited.get("codemode") ?? {}),
          parameters: (inherited.get("codemode")?.parameters ?? definition.parameters) as Pi.ToolDefinition["parameters"],
          prepareLoadout: loadout => {
            const changes = definition.prepareLoadout?.(loadout);
            return { ...changes, descriptions: { ...changes?.descriptions,
              ...Object.fromEntries(declarations.map(tool => [tool.name, tool.description])) } };
          },
        });
      } }));
    }],
  });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  if (errors.length) throw new Error(`Worker tool loading failed: ${errors.map(error => error.error).join("; ")}`);
  // Keep declaration order; only add codemode when the parent did not have it.
  return { loader, tools: [...declarations.map(tool => tool.name), ...(!inherited.has("codemode") ? ["codemode"] : [])], unavailable };
}
