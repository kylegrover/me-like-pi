// claude_web_search: web search via the local Claude Code CLI on the Claude subscription.
// A stopgap until SearXNG; it doesn't need the openai-codex login.
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_QUERIES, MAX_QUERY_CHARS, searchClaude, type ClaudeSearchResult } from "./lib/claude-search.ts";

export default function claudeSearch(pi: ExtensionAPI) {
  registerClaudeSearch(pi);
}

export function registerClaudeSearch(pi: ExtensionAPI, search = searchClaude) {
  pi.registerTool({
    name: "claude_web_search", label: "Web search (Claude)",
    description: "Search the public web with up to three nonsensitive queries per call, using the local Claude Code CLI (Claude subscription). Returns a cited Claude summary from search results, not verified page text. Takes 10-60 seconds. No retries or provider fallback.",
    parameters: Type.Object({ queries: Type.Array(Type.String({ minLength: 1, maxLength: MAX_QUERY_CHARS }), { minItems: 1, maxItems: MAX_QUERIES }) }),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      if (!Array.isArray(params.queries) || params.queries.length < 1 || params.queries.length > MAX_QUERIES ||
        params.queries.some(q => typeof q !== "string" || !q.trim() || q.length > MAX_QUERY_CHARS))
        throw new Error("Invalid search batch");
      const r: ClaudeSearchResult = await search(params.queries, signal);
      return { content: [{ type: "text", text: `Claude web search (summary with provider citations, not verified pages):\n\n${r.text}` }],
        details: { provider: "claude-code-cli", model: r.model, turns: r.turns, durationMs: r.durationMs,
          equivalentCostUsd: r.costUsd, usage: r.usage, queryCount: params.queries.length } };
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("muted", "Searching (Claude)..."), 0, 0);
      const body = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      const d = result.details as { model?: string; turns?: number; durationMs?: number } | undefined;
      if (!d) return new Text(theme.fg("error", body), 0, 0);
      const summary = `${d.model ?? "claude"} · ${d.turns ?? "?"} turns · ${((d.durationMs ?? 0) / 1000).toFixed(1)}s`;
      return new Text(theme.fg("muted", summary) + (expanded ? `\n${body}` : ""), 0, 0);
    },
  });
}
