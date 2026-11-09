import type { Progress } from "./delegation-run.ts";

// Plain-text worker display helpers shared by the delegate tool block and /do panel.
const seconds = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Plain lines for the live worker feed; the caller applies theme colours. */
export function progressLines(p: Progress, now = Date.now()) {
  return [`worker running · ${seconds(now - p.startedAt)} · ${plural(p.requests, "request")} · ${plural(p.tools, "tool call")}`,
    ...p.recent.map(line => `  › ${line}`)];
}
/** One-line summary for a finished worker, from runDelegate() details. */
export function summaryLine(d: { status?: string; elapsedMs?: number; requests?: number; tools?: number; toolErrors?: number; isError?: boolean }) {
  const parts = [d.status ?? (d.isError ? "incomplete" : "completed")];
  if (typeof d.elapsedMs === "number") parts.push(seconds(d.elapsedMs));
  if (typeof d.requests === "number") parts.push(plural(d.requests, "request"));
  if (typeof d.tools === "number") parts.push(plural(d.tools, "tool call"));
  if (d.toolErrors) parts.push(plural(d.toolErrors, "tool error"));
  return parts.join(" · ");
}
