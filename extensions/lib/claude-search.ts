// Web search through the local Claude Code CLI (WebSearch/WebFetch tools) on the
// user's Claude subscription. One `claude -p` process per batch; no fallback.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

export const MAX_QUERIES = 3;
export const MAX_QUERY_CHARS = 240;
export const MAX_RESULT_CHARS = 16_000;
export const TIMEOUT_MS = 120_000;
export const DEFAULT_MODEL = "haiku";

export type ClaudeSearchResult = {
  text: string; model?: string; turns?: number; durationMs?: number;
  costUsd?: number; usage?: Record<string, unknown>;
};

export function searchPrompt(queries: string[]): string {
  return [
    "Search the public web for the following and answer each one concisely.",
    "Use WebSearch; use WebFetch only when a snippet isn't enough to answer.",
    "Cite source URLs inline. Say plainly what you could not verify or where sources disagree.",
    "Do not read or change any local files.",
    "",
    ...queries.map((q, i) => `${i + 1}. ${q}`),
  ].join("\n");
}

export function searchArgs(queries: string[], model = DEFAULT_MODEL): string[] {
  return ["-p", searchPrompt(queries), "--model", model,
    "--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch",
    "--output-format", "json", "--no-session-persistence", "--strict-mcp-config",
    "--disable-slash-commands", "--setting-sources", ""];
}

/** Child env: never let an API key turn a subscription search into metered API use. */
export function searchEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _k, ANTHROPIC_AUTH_TOKEN: _t, ...rest } = env;
  return rest;
}

export function parseSearchOutput(stdout: string): ClaudeSearchResult {
  let j: any;
  try { j = JSON.parse(stdout.trim().split("\n").at(-1) ?? ""); } catch { throw new Error("Claude search returned no JSON result"); }
  if (j?.type !== "result") throw new Error("Claude search returned an unexpected result");
  if (j.is_error || j.subtype !== "success") throw new Error(`Claude search failed: ${String(j.result ?? j.subtype ?? "unknown").slice(0, 300)}`);
  const text = String(j.result ?? "").trim();
  if (!text) throw new Error("Claude search returned an empty answer");
  return { text, model: Object.keys(j.modelUsage ?? {})[0], turns: j.num_turns, durationMs: j.duration_ms,
    costUsd: j.total_cost_usd, usage: j.usage };
}

export type Runner = (bin: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string; signal: AbortSignal }) =>
  Promise<{ code: number | null; stdout: string; stderr: string }>;

export const spawnRunner: Runner = (bin, args, { env, cwd, signal }) => new Promise((resolve, reject) => {
  const child = spawn(bin, args, { env, cwd, signal, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => { if (stdout.length < 4_000_000) stdout += d; });
  child.stderr.on("data", d => { if (stderr.length < 20_000) stderr += d; });
  child.on("error", reject);
  child.on("close", code => resolve({ code, stdout, stderr }));
});

export async function searchClaude(queries: string[], signal?: AbortSignal, run: Runner = spawnRunner,
  env: NodeJS.ProcessEnv = process.env): Promise<ClaudeSearchResult> {
  const bin = env.PI_CLAUDE_SEARCH_BIN || "claude";
  const model = env.PI_CLAUDE_SEARCH_MODEL || DEFAULT_MODEL;
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  let out;
  try {
    // Neutral cwd so no project CLAUDE.md or settings are picked up.
    out = await run(bin, searchArgs(queries, model), { env: searchEnv(env), cwd: tmpdir(), signal: deadline });
  } catch (error: any) {
    if (deadline.aborted) throw new Error(signal?.aborted ? "Claude search cancelled" : `Claude search timed out after ${TIMEOUT_MS / 1000}s`);
    if (error?.code === "ENOENT") throw new Error(`Claude Code CLI not found (${bin}); install it or set PI_CLAUDE_SEARCH_BIN`);
    throw error;
  }
  if (out.code !== 0 && !out.stdout.trim()) throw new Error(`Claude search exited ${out.code}: ${out.stderr.trim().slice(0, 300) || "no output"}`);
  const result = parseSearchOutput(out.stdout);
  if (result.text.length > MAX_RESULT_CHARS) result.text = result.text.slice(0, MAX_RESULT_CHARS) + "\n[truncated]";
  return result;
}
