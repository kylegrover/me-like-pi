// `@path.md` includes in ~/.pi/agent/AGENTS.md, like Claude Code's @imports.
// A line that is only `@some/file.md` pulls that file in as one more context file, right
// after AGENTS.md. `{os}` (windows|mac|linux) and `{host}` (short hostname) are filled in,
// and a missing file is skipped, so `@machines/{os}.md` works on every device.
// Only the global AGENTS.md expands; project AGENTS.md files are left alone, except that a
// project file that is the same file as an earlier one (this repo's AGENTS.md, linked as the
// global one) is dropped, so it isn't in the prompt twice.
import { hostname } from "node:os";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentVars, duplicateIndexes, expandIncludes, isAgentDirFile, type Expansion } from "./lib/context-include.ts";

export default function includes(pi: ExtensionAPI) {
  const vars = currentVars(process.platform, hostname());
  let last: Expansion | undefined;

  pi.on("before_agent_start", (event) => {
    const files = event.systemPromptOptions.contextFiles;
    for (const i of duplicateIndexes(files).reverse()) files.splice(i, 1);
    const index = files.findIndex(f => isAgentDirFile(f.path, getAgentDir()));
    if (index < 0) { last = undefined; return; }
    last = expandIncludes([files[index]!], vars);
    const present = new Set(files.map(f => f.path));
    // Same files in the same order every turn, so the prompt stays cache-stable.
    const add = last.included.filter(f => !present.has(f.path));
    files.splice(index + 1, 0, ...add);
  });

  pi.registerCommand("includes", {
    description: "Show which @includes from ~/.pi/agent/AGENTS.md were loaded",
    handler: async (_args, ctx) => {
      if (!last) { ctx.ui.notify(`No @includes yet (os=${vars.os}, host=${vars.host}). Send a message first.`, "info"); return; }
      const lines = [`os=${vars.os} host=${vars.host}`,
        ...last.included.map(f => `loaded   ${f.path}`),
        ...last.missing.map(p => `missing  ${p}`),
        ...last.skipped.map(p => `skipped  ${p}`)];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
