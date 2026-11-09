import { readFileSync } from "node:fs";

/**
 * A delegate worker's session file starts with the parent's whole conversation
 * (copied as context), then a `delegate-origin` entry, then the worker's own turns.
 * These helpers return only what the worker itself did, so the parent can read a
 * run without paging through history it already has.
 */
export type SpanEntry = { id: string; kind: string; text: string };

const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((c: any) => {
    if (c?.type === "text") return c.text;
    if (c?.type === "toolCall") return `${c.name} ${JSON.stringify(c.arguments)}`;
    return ""; // images, thinking and signatures are omitted
  }).filter(Boolean).join("\n") : "";

/** The worker's own entries, after the copied parent context. */
export function workerSpan(file: string): SpanEntry[] {
  const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const start = entries.findIndex(e => e.type === "custom" && e.customType === "delegate-origin");
  if (start < 0) throw new Error("That session is not a delegate worker.");
  const out: SpanEntry[] = [];
  for (const e of entries.slice(start)) {
    if (e.type === "custom" && e.customType === "delegate-origin") out.push({ id: e.id, kind: "assignment", text: String(e.data?.task ?? "") });
    else if (e.type === "custom" && e.customType === "delegate-continue") out.push({ id: e.id, kind: `continuation ${e.data?.index}`, text: String(e.data?.task ?? "") });
    else if (e.type === "custom" && e.customType === "delegate-result") {
      const d = e.data ?? {};
      out.push({ id: e.id, kind: "result", text: `${d.status}${d.reason ? `: ${d.reason}` : ""}; ${d.requests} requests${d.files?.length ? `; files: ${d.files.join(", ")}` : ""}` });
    } else if (e.type === "message") {
      const m = e.message;
      const kind = m.role === "toolResult" ? `tool result ${m.toolName ?? ""}${m.isError ? " (error)" : ""}`.trim() : m.role;
      const text = textOf(m.content);
      if (text) out.push({ id: e.id, kind, text });
    }
  }
  return out;
}

/** List (optionally filtered by a literal query) or read one entry, paged. */
export function readSpan(span: SpanEntry[], args: { query?: string; entryId?: string; offset?: number; limit?: number }) {
  const offset = args.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
  if (args.entryId) {
    const e = span.find(s => s.id === args.entryId);
    if (!e) throw new Error("Entry is not among this worker's own turns");
    return { entryId: e.id, kind: e.kind, totalChars: e.text.length, offset, text: e.text.slice(offset, offset + 8000),
      nextOffset: offset + 8000 < e.text.length ? offset + 8000 : null };
  }
  const query = (args.query ?? "").toLowerCase();
  const matches = span.filter(s => s.text.toLowerCase().includes(query) || s.kind.includes(query));
  const limit = Math.min(30, Math.max(1, args.limit ?? 20));
  return { entries: span.length, matches: matches.length, offset, nextOffset: offset + limit < matches.length ? offset + limit : null,
    items: matches.slice(offset, offset + limit).map(s => {
      const hit = query ? Math.max(0, s.text.toLowerCase().indexOf(query)) : 0;
      return { id: s.id, kind: s.kind, chars: s.text.length, excerpt: s.text.slice(Math.max(0, hit - 80), Math.max(0, hit - 80) + 300) };
    }) };
}
