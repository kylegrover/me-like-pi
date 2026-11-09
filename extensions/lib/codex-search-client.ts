// Search-only Codex Responses client. No package config, browser actions, or provider fallback.
export const CODEX_SEARCH_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const SEARCH_MODEL = "gpt-6-luna"; // Explicit pilot choice; live support not yet verified.
export const MAX_QUERIES = 3;
export const MAX_QUERY_CHARS = 240;
export const MAX_STREAM_BYTES = 128 * 1024;
export const MAX_RESULT_CHARS = 12_000;
export const TIMEOUT_MS = 60_000;

type Fetcher = typeof fetch;
export type SearchResult = {
  text: string;
  citations: { title: string; url: string }[];
  searchCalls: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

type Frame = { event: string; data: unknown };
function frameFrom(raw: string): Frame | undefined {
  const lines = raw.split(/\r?\n/);
  const event = lines.find(l => l.startsWith("event:"))?.slice(6).trim();
  const data = lines.filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
  if (!event || !data || data === "[DONE]") return undefined;
  try { return { event, data: JSON.parse(data) }; }
  catch { throw new Error("Malformed Codex search event"); }
}

function mergeSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS)
    throw new Error("Invalid Codex search timeout");
  const timer = AbortSignal.timeout(timeoutMs);
  return AbortSignal.any(signal ? [timer, signal] : [timer]);
}

/** One bounded hosted search. Each query is its own Codex request. */
export async function searchCodex(query: string, token: string, accountId: string,
  signal?: AbortSignal, fetcher: Fetcher = fetch, timeoutMs = TIMEOUT_MS): Promise<SearchResult> {
  if (!query.trim() || query.length > MAX_QUERY_CHARS) throw new Error("Invalid search query length");
  if (!token || !accountId) throw new Error("Codex authentication unavailable");
  const combined = mergeSignal(signal, timeoutMs);
  if (combined.aborted) throw combined.reason;
  // Do not follow any redirect with credential-bearing headers, even within chatgpt.com.
  const response = await fetcher(CODEX_SEARCH_ENDPOINT, {
    method: "POST", redirect: "manual", signal: combined,
    headers: {
      authorization: `Bearer ${token}`, "chatgpt-account-id": accountId,
      originator: "codex_cli_rs", accept: "text/event-stream", "content-type": "application/json",
    },
    body: JSON.stringify({
      model: SEARCH_MODEL,
      instructions: "You are a concise web search assistant. Use web search, answer the query, and preserve source citations from annotations.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: query }] }],
      tools: [{ type: "web_search", external_web_access: true, search_context_size: "medium" }],
      tool_choice: "required", parallel_tool_calls: false, store: false, stream: true, include: [],
    }),
  });
  if (response.status >= 300 && response.status < 400) throw new Error("Codex search redirect blocked");
  if (!response.ok) throw new Error(`Codex search HTTP ${response.status}`);
  if (!response.body) throw new Error("Codex search returned no stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, buffer = "", text = "", completed = false, usage: SearchResult["usage"];
  const citations = new Map<string, { title: string; url: string }>();
  const calls = new Set<string>();
  const parse = (raw: string) => {
    const frame = frameFrom(raw); if (!frame) return;
    const data = frame.data as Record<string, any>;
    if (frame.event === "response.failed" || frame.event === "response.incomplete")
      throw new Error("Codex search did not complete");
    if (frame.event === "response.completed") {
      if (completed) throw new Error("Duplicate Codex search completion");
      completed = true;
      const u = data?.response?.usage;
      if (u && typeof u === "object") usage = {
        inputTokens: u.input_tokens, outputTokens: u.output_tokens, totalTokens: u.total_tokens,
      };
    }
    if (frame.event === "response.output_item.done") {
      const item = data?.item;
      if (item?.type === "web_search_call") calls.add(item.id ?? `call-${calls.size + 1}`);
      if (item?.type === "message" && item.role === "assistant") for (const part of item.content ?? []) {
        if (part.type !== "output_text") continue;
        if (typeof part.text === "string") text += part.text;
        for (const a of part.annotations ?? []) if (a.type === "url_citation" && typeof a.url === "string") {
          // Provider citations are references, not locally verified page passages.
          try { const url = new URL(a.url); if (["http:", "https:"].includes(url.protocol) && a.url.length <= 1024 && citations.size < 12)
            citations.set(a.url, { title: String(a.title ?? "").slice(0, 160), url: a.url }); } catch { /* invalid citation */ }
        }
      }
    }
    if (text.length > MAX_RESULT_CHARS) throw new Error("Codex search answer exceeds output limit");
  };
  // A test fetcher (or unusual transport) may not abort a pending reader.read() on its own.
  const cancelRead = () => { void reader.cancel(combined.reason).catch(() => undefined); };
  combined.addEventListener("abort", cancelRead, { once: true });
  try {
    while (true) {
      if (combined.aborted) throw combined.reason;
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw new Error("Codex search stream exceeds size limit");
      buffer += decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        parse(raw);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) parse(buffer);
    if (combined.aborted || !completed || !text.trim()) throw new Error("Incomplete Codex search stream");
    return { text, citations: [...citations.values()], searchCalls: calls.size, usage };
  } catch (error) {
    if (combined.aborted) throw combined.reason;
    throw error;
  } finally {
    combined.removeEventListener("abort", cancelRead);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export type BatchAttempt = { query: string; result?: SearchResult; error?: string };
export type BatchReport = {
  attempts: BatchAttempt[];
  requestedCount: number;
  attemptedCount: number;
  completedCount: number;
  failedCount: number;
  notAttemptedCount: number;
  reportedUsageCount: number;
  unknownUsageCount: number;
  partial: boolean;
};

/** Counts invoked search operations, not unobservable provider-internal requests. */
export async function runCodexBatch(queries: readonly string[], search: (query: string) => Promise<SearchResult>,
  signal?: AbortSignal): Promise<BatchReport> {
  const attempts: BatchAttempt[] = [];
  for (const query of queries) {
    if (signal?.aborted) throw signal.reason;
    try {
      attempts.push({ query, result: await search(query.trim()) });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      attempts.push({ query, error: error instanceof Error ? error.message : "Search failed" });
      break; // No retries or further queries after failure.
    }
  }
  if (signal?.aborted) throw signal.reason;
  const completedCount = attempts.filter(a => a.result).length;
  const reportedUsageCount = attempts.filter(a => a.result?.usage &&
    Object.values(a.result.usage).some(v => Number.isSafeInteger(v) && v >= 0)).length;
  return {
    attempts, requestedCount: queries.length, attemptedCount: attempts.length,
    completedCount, failedCount: attempts.length - completedCount,
    notAttemptedCount: queries.length - attempts.length,
    reportedUsageCount, unknownUsageCount: attempts.length - reportedUsageCount,
    partial: attempts.length !== queries.length || completedCount !== queries.length,
  };
}
