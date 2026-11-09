// Provider-neutral `web_search`. One backend, chosen explicitly in config; no fallback.
//   searxng: self-hosted SearXNG (or degoog in SearXNG-API mode); returns result lists.
//   codex:   hosted Codex search via the openai-codex login; returns a cited synthesis.
// Config: $PI_WEB_SEARCH_CONFIG, else ~/.pi/agent/web-search.json, e.g.
//   { "backend": "searxng", "searxng": { "url": "http://searxng.local:8888/search" } }
// Replaces pi-codex-search-pilot.ts once enabled; both register `web_search`, so enable one.
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_QUERIES, MAX_QUERY_CHARS, SEARCH_MODEL, runCodexBatch, searchCodex } from "./lib/codex-search-client.ts";
import { formatSearxng, loadConfig, searchSearxng, type SearxngResult, type WebSearchConfig } from "./lib/searxng-client.ts";

const BATCH_DEADLINE_MS = 60_000;
const MAX_TOOL_TEXT = 16_000;

function accountIdFromToken(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const value = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    const id = value?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch { return undefined; }
}

type Display = {
  backend: "searxng" | "codex"; elapsedMs: number;
  requestedQueryCount: number; completedQueryCount: number; failedQueryCount: number;
  notAttemptedQueryCount: number; partial: boolean; hitCount?: number; failedEngines?: number;
};

export type Deps = {
  load?: () => WebSearchConfig;
  searxng?: typeof searchSearxng;
  codex?: typeof searchCodex;
  readCredential?: typeof readStoredCredential;
};

export default function webSearch(pi: ExtensionAPI) { registerWebSearch(pi); }

export function registerWebSearch(pi: ExtensionAPI, deps: Deps = {}) {
  const load = deps.load ?? (() => loadConfig());
  const searx = deps.searxng ?? searchSearxng;
  const codex = deps.codex ?? searchCodex;
  const readCredential = deps.readCredential ?? readStoredCredential;
  // Successful batches allow follow-ups. Any failure blocks this run, not other sessions.
  let open = false, blocked = false, runId = 0;
  let active: AbortController | undefined;
  const stop = () => {
    open = false; runId++;
    active?.abort(new Error("Web search run ended or session changed"));
    active = undefined;
  };
  pi.on("session_start", () => { stop(); blocked = false; });
  pi.on("before_agent_start", () => { if (!open) { open = true; blocked = false; runId++; } });
  pi.on("agent_settled", stop);
  pi.on("session_shutdown", stop);
  pi.registerTool({
    name: "web_search", label: "Web search",
    description: "Search the public web with up to three nonsensitive queries per call. Depending on the configured backend, returns either ranked result lists (title, URL, snippet) from a self-hosted metasearch engine, or a hosted synthesis with citations; neither is verified page text. Follow-up calls are allowed after success; a failure blocks further searches in this agent run. No browser, automatic retries, or backend fallback.",
    parameters: Type.Object({ queries: Type.Array(Type.String({ minLength: 1, maxLength: MAX_QUERY_CHARS }), { minItems: 1, maxItems: MAX_QUERIES }) }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!open) throw new Error("No active agent run");
      if (blocked) throw new Error("Web search blocked after a failure in this agent run; no retries");
      if (active) throw new Error("Web search batch already in progress");
      if (!Array.isArray(params.queries) || params.queries.length < 1 || params.queries.length > MAX_QUERIES ||
        params.queries.some(q => typeof q !== "string" || !q.trim() || q.length > MAX_QUERY_CHARS))
        throw new Error("Invalid search batch");
      const startedAt = performance.now();
      const thisRun = runId;
      const controller = new AbortController(); active = controller;
      const deadline = AbortSignal.any(signal
        ? [signal, controller.signal, AbortSignal.timeout(BATCH_DEADLINE_MS)]
        : [controller.signal, AbortSignal.timeout(BATCH_DEADLINE_MS)]);
      const checkRun = () => {
        if (!open || thisRun !== runId) throw new Error("Web search run ended or session changed");
        if (deadline.aborted) throw deadline.reason;
      };
      try {
        checkRun();
        const config = load();
        if (config.backend === "searxng") {
          const results = new Map<string, SearxngResult>();
          const batch = await runCodexBatch(params.queries, async query => {
            checkRun();
            const r = await searx(query, config.searxng, deadline);
            results.set(query, r);
            return { text: "", citations: [], searchCalls: 1 };
          }, deadline);
          checkRun();
          if (batch.failedCount) blocked = true;
          if (!batch.completedCount) throw new Error(`Web search (SearXNG) failed: ${batch.attempts[0]?.error ?? "unknown"}`);
          const shaped = batch.attempts.map(a => ({ a, r: results.get(a.query.trim()) }));
          let text = shaped.map(({ a, r }, i) => a.error || !r ? `Query ${i + 1}: FAILED (${a.error})` : formatSearxng(a.query, i, r)).join("\n\n");
          if (text.length > MAX_TOOL_TEXT) text = `${text.slice(0, MAX_TOOL_TEXT)}\n…(truncated)`;
          const hitCount = shaped.reduce((n, { r }) => n + (r?.hits.length ?? 0), 0);
          const failedEngines = shaped.reduce((n, { r }) => n + (r?.unresponsiveEngines.length ?? 0), 0);
          const summary = `SearXNG search: ${batch.completedCount}/${batch.requestedCount} queries completed; ` +
            `${batch.failedCount} failed, ${batch.notAttemptedCount} not attempted; ${hitCount} results ` +
            `(search-engine snippets, not verified page text).`;
          return { content: [{ type: "text", text: `${summary}\n\n${text}` }],
            details: { backend: "searxng", endpoint: new URL(config.searxng.url).origin, evidenceKind: "search_results",
              elapsedMs: Math.round(performance.now() - startedAt),
              requestedQueryCount: batch.requestedCount, attemptedQueryCount: batch.attemptedCount,
              completedQueryCount: batch.completedCount, failedQueryCount: batch.failedCount,
              notAttemptedQueryCount: batch.notAttemptedCount, partial: batch.partial, hitCount, failedEngines,
              results: shaped.map(({ a, r }) => ({ query: a.query, status: a.error ? "failed" : "completed",
                error: a.error, hitCount: r?.hits.length, unresponsiveEngines: r?.unresponsiveEngines })) } };
        }
        // codex backend (same behavior as pi-codex-search-pilot.ts)
        const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
        checkRun();
        if (!token) throw new Error("Codex login required: /login openai-codex");
        const credential = readCredential("openai-codex") as { type?: string; accountId?: string } | undefined;
        const accountId = credential?.type === "oauth" && credential.accountId?.trim() || accountIdFromToken(token);
        if (!accountId) throw new Error("Codex account ID unavailable; re-login required");
        const batch = await runCodexBatch(params.queries, query => { checkRun(); return codex(query, token, accountId, deadline); }, deadline);
        checkRun();
        if (batch.failedCount) blocked = true;
        const text = batch.attempts.map((r, i) => r.error ? `Query ${i + 1}: FAILED (${r.error}; usage unknown)` :
          `Query ${i + 1}: ${r.query}\n${r.result?.text}\n` +
          `Provider citations (not verified pages):\n${r.result?.citations.map(c => `- ${c.title}: ${c.url}`).join("\n") || "(none)"}`).join("\n\n");
        if (text.length > MAX_TOOL_TEXT) throw new Error("Codex search batch exceeds result limit");
        if (!batch.completedCount) throw new Error(`Codex search failed after ${batch.attemptedCount} attempt(s); usage unknown: ${batch.attempts[0]?.error ?? "unknown"}`);
        const summary = `Codex search: ${batch.completedCount}/${batch.requestedCount} queries completed; ` +
          `${batch.failedCount} failed, ${batch.notAttemptedCount} not attempted.`;
        return { content: [{ type: "text", text: `${summary}\n\n${text}` }],
          details: { backend: "codex", provider: "openai-codex", model: SEARCH_MODEL, evidenceKind: "provider_summary",
            elapsedMs: Math.round(performance.now() - startedAt),
            requestedQueryCount: batch.requestedCount, attemptedQueryCount: batch.attemptedCount,
            completedQueryCount: batch.completedCount, failedQueryCount: batch.failedCount,
            notAttemptedQueryCount: batch.notAttemptedCount, partial: batch.partial,
            results: batch.attempts.map(r => ({ query: r.query, status: r.error ? "failed" : "completed",
              error: r.error, citationCount: r.result?.citations.length, usage: r.result?.usage })) } };
      } catch (error) {
        if (thisRun === runId) blocked = true;
        throw error;
      } finally {
        if (active === controller) active = undefined;
      }
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("muted", "Searching..."), 0, 0);
      const body = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      const d = result.details as Display | undefined;
      if (!d) return new Text(theme.fg("error", body), 0, 0);
      const extra = d.backend === "searxng"
        ? ` · ${d.hitCount ?? 0} results${d.failedEngines ? ` · ${d.failedEngines} engine failures` : ""}` : "";
      const summary = `${d.backend} · ${d.completedQueryCount}/${d.requestedQueryCount} completed · ${d.failedQueryCount} failed · ` +
        `${d.notAttemptedQueryCount} not attempted · ${(d.elapsedMs / 1000).toFixed(1)}s${extra}`;
      return new Text(theme.fg(d.partial ? "warning" : "muted", summary) + (expanded ? `\n${body}` : ""), 0, 0);
    },
  });
}
