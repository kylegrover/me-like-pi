/**
 * Edit compaction (docs/WARM_COMPACT.md): the default mode of /warm-compact.
 *
 * Instead of replacing old history with a summary, change it with `context_edit` entries:
 *  1. rules (no model): old tool results and long tool-call arguments become short placeholders
 *     that keep their opening and name the entry, so `context_recall` can restore the original;
 *     thinking is dropped from old replies;
 *  2. the model, in a cache-warm turn, sees the full context and a map of the old user/assistant
 *     messages, and returns a small JSON edit plan: condense a message, fold finished stretches
 *     into a note, or regex-replace inside a message.
 * Raw history is never changed; edits only affect future model context.
 */
import { estimateMessageTokens } from "./warm-compact.ts";

export const RESULT_KEEP = 300;   // chars of a tool result kept in its placeholder
export const ARGS_KEEP = 200;     // chars of tool-call arguments kept
export const STUB_OVER = 400;     // only stub results / arguments longer than this
export const FOLDED_FILLER = "[folded into the note above]";

type Projected = { sourceEntry: { id: string; type: string; [k: string]: any }; messages: any[] };
export type EditDraft = { type: "context_edit"; targetId: string; replacement: { content: any } | null };
export type MapItem = { n: number; index: number; entryId: string; role: "user" | "assistant"; tokens: number; opening: string;
  /** Already shortened by an earlier pass (its projected content differs from the raw entry). */
  compacted?: boolean };
export type Op =
  | { op: "condense"; n: number; text: string }
  | { op: "fold"; from: number; to: number; note: string }
  | { op: "replace"; n: number; find: string; with: string }
  | { op: "keep"; n: number };

const textOf = (content: any): string =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : "";

export const recallNote = (id: string, what: string, chars: number) =>
  `[… ${chars.toLocaleString("en-US")} more chars of ${what} elided; context_recall("${id}") restores the original]`;

/** The message an entry contributes, if it is a single plain message. */
const only = (p: Projected) => (p.messages.length === 1 ? p.messages[0] : undefined);

/** Rule pass on one message: returns new content, or undefined if nothing changes. */
export function ruleContent(entryId: string, m: any): any[] | undefined {
  if (m?.role === "toolResult") {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
    const text = textOf(blocks);
    const images = blocks.filter((b: any) => b?.type === "image").length;
    if (text.length <= STUB_OVER && images === 0) return undefined;
    if (text.includes("context_recall(\"") && images === 0) return undefined; // already a placeholder from an earlier pass
    const head = text.slice(0, RESULT_KEEP);
    const rest = text.length - head.length;
    const note = rest > 0 ? recallNote(entryId, "tool output", rest) : "";
    const img = images ? `[${images} image(s) elided; context_recall("${entryId}") restores them]` : "";
    return [{ type: "text", text: [head, note, img].filter(Boolean).join("\n") }];
  }
  if (m?.role === "assistant" && Array.isArray(m.content)) {
    let changed = false;
    const out: any[] = [];
    for (const b of m.content) {
      if (b?.type === "thinking" || b?.type === "redactedThinking") { changed = true; continue; }
      if (b?.type === "toolCall") {
        const json = JSON.stringify(b.arguments ?? {});
        if (json.length > STUB_OVER && b.arguments?._elided === undefined) {
          changed = true;
          out.push({ ...b, arguments: { _elided: `${json.slice(0, ARGS_KEEP)}${recallNote(entryId, "arguments", json.length - ARGS_KEEP)}` } });
          continue;
        }
      }
      out.push(b);
    }
    return changed ? out : undefined;
  }
  return undefined;
}

/** Rule edits for entries [start, cut). */
export function ruleEdits(projected: Projected[], start: number, cut: number): Map<string, EditDraft> {
  const edits = new Map<string, EditDraft>();
  for (let i = start; i < cut; i++) {
    const p = projected[i]!;
    if (p.sourceEntry.type !== "message") continue;
    const m = only(p);
    const content = m && ruleContent(p.sourceEntry.id, m);
    if (content) edits.set(p.sourceEntry.id, { type: "context_edit", targetId: p.sourceEntry.id, replacement: { content } });
  }
  return edits;
}

/** The user/assistant messages with text in [start, cut), numbered for the model. */
export function buildMap(projected: Projected[], start: number, cut: number): MapItem[] {
  const items: MapItem[] = [];
  for (let i = start; i < cut; i++) {
    const p = projected[i]!;
    const m = only(p);
    if (!m || (m.role !== "user" && m.role !== "assistant" && m.role !== "custom")) continue;
    const text = textOf(m.content).trim();
    // Skip empty messages and an earlier fold's filler ("[folded into the note above]"): nothing to plan.
    if (!text || text === FOLDED_FILLER) continue;
    const raw = p.sourceEntry.message?.content;
    const compacted = raw !== undefined && JSON.stringify(raw) !== JSON.stringify(m.content);
    items.push({ n: items.length + 1, index: i, entryId: p.sourceEntry.id, role: m.role === "assistant" ? "assistant" : "user",
      tokens: Math.ceil(text.length / 4), opening: text.replace(/\s+/g, " ").slice(0, 90), ...(compacted ? { compacted } : {}) });
  }
  return items;
}

export function mapText(items: MapItem[]): string {
  return items.map(it => `#${it.n} ${it.role}${it.compacted ? " (compacted)" : ""} ~${it.tokens} tok: ${JSON.stringify(it.opening)}`).join("\n");
}

/** Read the JSON edit plan from the model's reply. */
export function parsePlan(reply: string): { ops?: Op[]; invalid?: string[]; error?: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
  const raw = (fenced ? fenced[1] : reply).trim();
  let data: any;
  try { data = JSON.parse(raw); } catch (e) { return { error: `not JSON (${(e as Error).message.slice(0, 80)})` }; }
  const list = Array.isArray(data) ? data : data?.edits;
  if (!Array.isArray(list)) return { error: "no edits array" };
  const ops: Op[] = [];
  const invalid: string[] = [];
  for (const o of list) {
    if (o?.op === "condense" && Number.isInteger(o.n) && typeof o.text === "string") ops.push({ op: "condense", n: o.n, text: o.text });
    else if (o?.op === "fold" && Number.isInteger(o.from) && Number.isInteger(o.to) && o.to >= o.from && typeof o.note === "string") ops.push({ op: "fold", from: o.from, to: o.to, note: o.note });
    else if (o?.op === "replace" && Number.isInteger(o.n) && typeof o.find === "string" && typeof o.with === "string") ops.push({ op: "replace", n: o.n, find: o.find, with: o.with });
    else if (o?.op === "keep" && Number.isInteger(o.n)) ops.push({ op: "keep", n: o.n });
    else invalid.push(`malformed op: ${JSON.stringify(o).slice(0, 120)}`);
  }
  return { ops, invalid };
}

const roleOf = (p: Projected) => only(p)?.role;
const currentContent = (p: Projected, edits: Map<string, EditDraft>) => {
  const e = edits.get(p.sourceEntry.id);
  if (e) return e.replacement === null ? null : e.replacement.content;
  return only(p)?.content;
};

/**
 * Apply the model's plan on top of the rule edits. A fold #a–#b covers #a up to the next mapped
 * message after #b (so the unmapped tool-only steps and results after #b go with it, and calls and
 * results leave together), stopping early at a user message. It replaces only assistant work: every
 * user message stays verbatim. The first assistant run gets the note, later runs between kept user
 * messages a one-line pointer, so roles still alternate. If the fold ends right before another
 * assistant message in the same turn, that run's note is put at the start of that message instead,
 * so a following condense still applies and no two assistant messages end up adjacent. Returns the
 * final edits and the skipped ops with reasons.
 */
export function applyPlan(projected: Projected[], start: number, cut: number, items: MapItem[], ops: Op[],
  rules: Map<string, EditDraft>): { edits: Map<string, EditDraft>; skipped: string[] } {
  const edits = new Map(rules);
  const skipped: string[] = [];
  const byN = new Map(items.map(it => [it.n, it]));
  const set = (p: Projected, content: any | null) =>
    edits.set(p.sourceEntry.id, { type: "context_edit", targetId: p.sourceEntry.id, replacement: content === null ? null : { content } });
  const folded = new Set<number>();
  const prefixes = new Map<number, string[]>();
  const moves: { head: number; follower: number }[] = [];

  for (const op of ops.filter(o => o.op === "fold") as Extract<Op, { op: "fold" }>[]) {
    const a = byN.get(op.from), b = byN.get(op.to);
    if (!a || !b) { skipped.push(`fold #${op.from}-#${op.to}: unknown message`); continue; }
    if (a.index > b.index) { skipped.push(`fold #${op.from}-#${op.to}: reversed range`); continue; }
    const next = items.find(it => it.index > b.index);
    let end = (next ? next.index : cut) - 1;
    for (let i = b.index + 1; i <= end; i++) {
      const r = roleOf(projected[i]!);
      if (r === "user" || r === "custom") { end = i - 1; break; }
    }
    let noted = false, runOpen = false, lastRunHead = -1;
    for (let i = a.index; i <= end; i++) {
      const p = projected[i]!;
      if (p.sourceEntry.type !== "message" && p.sourceEntry.type !== "custom_message") continue;
      const role = roleOf(p);
      if (role === "user" || role === "custom") { runOpen = false; continue; } // user messages always stay
      folded.add(i);
      if (role === "assistant" && !runOpen) {
        // First message of an assistant run: the note, or a pointer back to it.
        runOpen = true;
        lastRunHead = i;
        set(p, [{ type: "text", text: noted ? FOLDED_FILLER : `[folded: ${op.note}]` }]);
        noted = true;
      } else set(p, null);
    }
    if (!noted) { skipped.push(`fold #${op.from}-#${op.to}: only user messages in range`); continue; }
    // The turn continues with another assistant message: move the last run's note onto it.
    const follower = end + 1;
    if (runOpen && follower < cut && roleOf(projected[follower]!) === "assistant") moves.push({ head: lastRunHead, follower });
  }
  for (const { head, follower } of moves) {
    const headEdit = edits.get(projected[head]!.sourceEntry.id);
    const note = (headEdit?.replacement as { content: any[] } | null)?.content?.[0]?.text as string | undefined;
    if (!note) continue;
    const fEdit = edits.get(projected[follower]!.sourceEntry.id);
    if (folded.has(follower)) {
      // The follower heads another fold: merge the notes there. If it was hidden, keep the note put.
      const fc = (fEdit?.replacement as { content: any[] } | null)?.content;
      if (!fc) continue;
      set(projected[follower]!, [{ type: "text", text: `${note}\n${fc[0].text}` }, ...fc.slice(1)]);
    } else prefixes.set(follower, [...(prefixes.get(follower) ?? []), note]);
    set(projected[head]!, null);
  }

  for (const op of ops) {
    if (op.op === "fold" || op.op === "keep") continue;
    const it = byN.get(op.n);
    if (!it) { skipped.push(`${op.op} #${op.n}: unknown message`); continue; }
    if (folded.has(it.index)) { skipped.push(`${op.op} #${op.n}: inside a fold`); continue; }
    const p = projected[it.index]!;
    const content = currentContent(p, edits);
    const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];
    if (op.op === "condense") {
      const rest = blocks.filter((b: any) => b?.type === "toolCall");
      set(p, [{ type: "text", text: op.text }, ...rest]);
    } else {
      let re: RegExp;
      try { re = new RegExp(op.find, "g"); } catch { skipped.push(`replace #${op.n}: bad regex`); continue; }
      set(p, blocks.map((b: any) => (b?.type === "text" ? { ...b, text: b.text.replace(re, op.with) } : b)));
    }
  }

  // Notes moved onto the next assistant message of their turn go in front of its (possibly condensed) text.
  for (const [i, notes] of prefixes) {
    const p = projected[i]!;
    const content = currentContent(p, edits);
    const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];
    set(p, [{ type: "text", text: notes.join("\n") }, ...blocks]);
  }

  // Safety: keep tool calls and results paired after all edits.
  const keptCalls = new Set<string>();
  for (let i = start; i < cut; i++) {
    const p = projected[i]!;
    const content = currentContent(p, edits);
    if (content === null || roleOf(p) !== "assistant" || !Array.isArray(content)) continue;
    for (const b of content) if (b?.type === "toolCall") keptCalls.add(b.id);
  }
  const keptResults = new Set<string>();
  for (let i = start; i < cut; i++) {
    const p = projected[i]!;
    const m = only(p);
    if (m?.role !== "toolResult" || currentContent(p, edits) === null) continue;
    if (!keptCalls.has(m.toolCallId)) set(p, null);
    else keptResults.add(m.toolCallId);
  }
  for (let i = start; i < cut; i++) {
    const p = projected[i]!;
    const content = currentContent(p, edits);
    if (content === null || roleOf(p) !== "assistant" || !Array.isArray(content)) continue;
    if (content.some((b: any) => b?.type === "toolCall" && !keptResults.has(b.id))) {
      const fixed = content.filter((b: any) => b?.type !== "toolCall" || keptResults.has(b.id));
      set(p, fixed.length ? fixed : [{ type: "text", text: "[tool call elided]" }]);
    }
  }
  return { edits, skipped };
}

/** Estimated tokens of [start, cut) with and without edits. */
export function sizes(projected: Projected[], start: number, cut: number, edits: Map<string, EditDraft>) {
  let before = 0, after = 0;
  for (let i = start; i < cut; i++) {
    const p = projected[i]!;
    for (const m of p.messages) before += estimateMessageTokens(m);
    const e = edits.get(p.sourceEntry.id);
    if (!e) { for (const m of p.messages) after += estimateMessageTokens(m); continue; }
    if (e.replacement === null) continue;
    after += estimateMessageTokens({ ...only(p), content: e.replacement.content });
  }
  return { before, after };
}

/** Tokens of the user/assistant text the map covers (what the model's plan works on). */
export function mapTokens(items: MapItem[]): number {
  return items.reduce((s, it) => s + it.tokens, 0);
}

export function editRequest(boundaryHint: string, items: MapItem[], rulesSaved: number, focus?: string): string {
  // The size target counts only messages not compacted before: earlier passes already did theirs.
  const fresh = items.filter(it => !it.compacted);
  const text = mapTokens(fresh);
  const keep = Math.max(1, Math.round((text * 0.4) / 1000));
  const earlier = items.length - fresh.length;
  const again = earlier ? `\n\n${earlier} messages are marked (compacted): an earlier pass already shortened them, and the cache is warm up to them. Leave them as they are unless something later made them obsolete; every change there makes the next turn rewrite the cache from that point.` : "";
  return `[pi-warm-compact request]
This is a context-compaction step, not a task. Do not call any tools. Reply with exactly one \`\`\`json block and nothing else.

The history before ${boundaryHint} will be compacted with edits, not replaced by a summary. That message and everything after it stay verbatim. In the older part, tool output and long tool-call arguments are already shortened automatically to their opening plus a recall handle, and thinking is dropped (about ${Math.round(rulesSaved / 1000)}k tokens saved). Your job is the conversation text: below is a map of the older user and assistant messages (#n, role, size, opening).

Return {"edits": [...]} using:
- {"op":"condense","n":12,"text":"..."}: replace message #12's text with a shorter version. Keep exact paths, commands, IDs, numbers, decisions and error messages that may still matter.
- {"op":"fold","from":3,"to":9,"note":"..."}: replace the assistant work in #3 to #9 with one note. User messages in the range always stay. Only for finished side-quests, dead ends and superseded attempts that later work doesn't build on.
- {"op":"replace","n":5,"find":"<regex>","with":"..."}: targeted edit inside #5.
Messages you don't mention stay as they are. Prefer condense over fold. Don't remove anything still needed verbatim.

Size target: the mapped conversation text${earlier ? " not yet compacted" : ""} is about ${Math.round(text / 1000)}k tokens. Leave at least ~${keep}k of it (about 40%). Compacting further loses detail that's cheap to keep.${again}${focus ? `\n\nAdditional focus: ${focus}` : ""}

Map:
${mapText(items)}`;
}
