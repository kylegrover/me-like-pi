// SearXNG-JSON search client. Works with SearXNG (`/search`) and degoog's
// SearXNG-compatible mode (`/api/search`, "Serve the SearXNG API shape").
// One GET per query to the configured endpoint only; no redirects, retries or fallback.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_QUERY_CHARS } from "./codex-search-client.ts";

export const SEARXNG_TIMEOUT_MS = 20_000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_RESULTS = 8;
export const MAX_RESULTS_CAP = 20;
const MAX_SNIPPET_CHARS = 400;
const MAX_TITLE_CHARS = 160;
const MAX_URL_CHARS = 1024;

type Fetcher = typeof fetch;

export type SearxngConfig = {
  /** Full search endpoint, e.g. http://searxng.local:8888/search or http://host:4444/api/search */
  url: string;
  /** Sent as `Authorization: Bearer` (degoog API keys, or a reverse proxy). Only to `url`'s origin. */
  apiKey?: string;
  maxResults?: number;
  /** Optional SearXNG `engines` / `categories` / `language` passthrough. */
  engines?: string;
  categories?: string;
  language?: string;
};

export type SearxngHit = { title: string; url: string; snippet: string; engines: string[] };
export type SearxngResult = {
  hits: SearxngHit[];
  answers: string[];
  suggestions: string[];
  /** Engines that failed for this query, as reported by the server ("name: reason"). */
  unresponsiveEngines: string[];
  usage?: undefined;
};

/** Validates a configured endpoint. Plain http is allowed (mesh/LAN); credentials in the URL are not. */
export function parseEndpoint(raw: unknown): URL {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("SearXNG url is not configured");
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error("SearXNG url is not a valid URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("SearXNG url must be http(s)");
  if (url.username || url.password) throw new Error("SearXNG url must not embed credentials; use apiKey");
  if (url.search || url.hash) throw new Error("SearXNG url must not include a query string or fragment");
  return url;
}

const clip = (s: unknown, n: number) => {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function safeUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > MAX_URL_CHARS) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch { return undefined; }
}

async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new Error("SearXNG returned no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0, text = "";
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("SearXNG response exceeds size limit");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Shapes a SearXNG JSON body into bounded hits. Exported for tests. */
export function shapeResults(body: unknown, maxResults: number): SearxngResult {
  if (!body || typeof body !== "object" || !Array.isArray((body as any).results))
    throw new Error("SearXNG response is not search JSON (is format=json enabled?)");
  const b = body as Record<string, any>;
  const seen = new Set<string>();
  const hits: SearxngHit[] = [];
  for (const r of b.results) {
    if (hits.length >= maxResults) break;
    const url = safeUrl(r?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const engines = Array.isArray(r.engines) ? r.engines : r.engine ? [r.engine] : [];
    hits.push({
      title: clip(r.title, MAX_TITLE_CHARS) || url,
      url,
      snippet: clip(r.content, MAX_SNIPPET_CHARS),
      engines: engines.filter((e: unknown) => typeof e === "string").slice(0, 6).map((e: string) => clip(e, 40)),
    });
  }
  const answers = (Array.isArray(b.answers) ? b.answers : [])
    .map((a: any) => clip(typeof a === "string" ? a : a?.answer, MAX_SNIPPET_CHARS)).filter(Boolean).slice(0, 3);
  const suggestions = (Array.isArray(b.suggestions) ? b.suggestions : [])
    .map((s: unknown) => clip(s, 80)).filter(Boolean).slice(0, 5);
  const unresponsiveEngines = (Array.isArray(b.unresponsive_engines) ? b.unresponsive_engines : [])
    .map((e: any) => Array.isArray(e) ? `${clip(e[0], 40)}: ${clip(e[1], 80)}` : clip(e, 120))
    .filter(Boolean).slice(0, 10);
  return { hits, answers, suggestions, unresponsiveEngines };
}

/** One bounded search against the configured endpoint. */
export async function searchSearxng(query: string, config: SearxngConfig, signal?: AbortSignal,
  fetcher: Fetcher = fetch, timeoutMs = SEARXNG_TIMEOUT_MS): Promise<SearxngResult> {
  if (!query.trim() || query.length > MAX_QUERY_CHARS) throw new Error("Invalid search query length");
  const endpoint = parseEndpoint(config.url);
  const maxResults = Math.min(Math.max(1, Math.trunc(config.maxResults ?? DEFAULT_MAX_RESULTS)), MAX_RESULTS_CAP);
  const url = new URL(endpoint);
  url.searchParams.set("q", query.trim());
  url.searchParams.set("format", "json");
  for (const key of ["engines", "categories", "language"] as const)
    if (typeof config[key] === "string" && config[key]!.trim()) url.searchParams.set(key, config[key]!.trim());
  const timer = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([timer, signal]) : timer;
  if (combined.aborted) throw combined.reason;
  const headers: Record<string, string> = { accept: "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  let response: Response;
  try {
    // Never follow redirects: they could carry the key or the query somewhere else.
    response = await fetcher(url.href, { method: "GET", redirect: "manual", signal: combined, headers });
  } catch (error) {
    if (combined.aborted) throw timer.aborted ? new Error(`SearXNG timed out after ${timeoutMs} ms`) : combined.reason;
    throw new Error(`SearXNG unreachable at ${endpoint.origin}: ${error instanceof Error ? error.message : error}`);
  }
  if (response.status >= 300 && response.status < 400) throw new Error("SearXNG redirect blocked");
  if (response.status === 403) throw new Error("SearXNG HTTP 403 (is format=json enabled in settings.yml search.formats?)");
  if (response.status === 429) throw new Error("SearXNG HTTP 429 (limiter; allow this client or disable the limiter on a private instance)");
  if (!response.ok) throw new Error(`SearXNG HTTP ${response.status}`);
  const text = await readBounded(response, combined);
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new Error("SearXNG returned non-JSON (is format=json enabled?)"); }
  return shapeResults(body, maxResults);
}

export type WebSearchConfig =
  | { backend: "searxng"; searxng: SearxngConfig & { apiKeyFile?: string } }
  | { backend: "codex" };

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_WEB_SEARCH_CONFIG || join(homedir(), ".pi", "agent", "web-search.json");
}

const expandHome = (p: string) => p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(2)) : p;

/** Reads and validates config. Throws a model-readable error; never guesses a backend. */
export function loadConfig(path = configPath()): WebSearchConfig {
  let raw: any;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (error: any) {
    throw new Error(error?.code === "ENOENT"
      ? `web_search is not configured: create ${path} with {"backend":"searxng","searxng":{"url":"…/search"}}`
      : `web_search config unreadable (${path}): ${error?.message ?? error}`);
  }
  if (raw?.backend === "codex") return { backend: "codex" };
  if (raw?.backend !== "searxng") throw new Error(`web_search config: backend must be "searxng" or "codex"`);
  const s = raw.searxng ?? {};
  parseEndpoint(s.url);
  let apiKey: string | undefined = typeof s.apiKey === "string" ? s.apiKey : undefined;
  if (typeof s.apiKeyFile === "string" && s.apiKeyFile) {
    try { apiKey = readFileSync(expandHome(s.apiKeyFile), "utf8").trim() || undefined; }
    catch { throw new Error(`web_search config: cannot read searxng.apiKeyFile`); }
  }
  return { backend: "searxng", searxng: {
    url: s.url, apiKey, maxResults: typeof s.maxResults === "number" ? s.maxResults : undefined,
    engines: s.engines, categories: s.categories, language: s.language,
  } };
}

/** Model-facing text for one query's results. */
export function formatSearxng(query: string, index: number, r: SearxngResult): string {
  const lines = [`Query ${index + 1}: ${query}`];
  if (r.answers.length) lines.push(...r.answers.map(a => `Answer (engine-provided): ${a}`));
  if (!r.hits.length) lines.push("(no results)");
  r.hits.forEach((h, i) => {
    lines.push(`${i + 1}. ${h.title}\n   ${h.url}` + (h.snippet ? `\n   ${h.snippet}` : "") +
      (h.engines.length ? `\n   [${h.engines.join(", ")}]` : ""));
  });
  if (r.suggestions.length) lines.push(`Suggestions: ${r.suggestions.join(" | ")}`);
  if (r.unresponsiveEngines.length) lines.push(`Engines that failed: ${r.unresponsiveEngines.join("; ")}`);
  return lines.join("\n");
}
