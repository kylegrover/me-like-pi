/**
 * Cache-warm compaction (docs/WARM_COMPACT.md): planning and the summary mode.
 *
 * Pi's own compaction sends a separate request (its own system prompt, no tools, the history
 * re-serialized as text), so it never reuses the prompt cache. Here the checkpoint request is
 * the next turn of the session itself: the cached context plus one hidden instruction. The
 * reply becomes a normal `compaction` entry; the instruction and the reply are then omitted
 * from future context with `context_edit`.
 *
 * Pure helpers only; the extension wiring is in extensions/pi-warm-compact.ts.
 */

export const CUSTOM_TYPE = "pi-warm-compact";
export const REQUEST_MARKER = "[pi-warm-compact request]";

/** Same headings as Pi's built-in summary, so /tree and later updates read it the same way. */
export const CHECKPOINT_FORMAT = `## Goal
[What the user is trying to accomplish. Can be several items.]

## Constraints & Preferences
- [Constraints, preferences or requirements the user stated, or "(none)"]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Data, examples or references needed to continue, or "(none)"]`;

type AnyEntry = { id: string; type: string; [k: string]: any };
type Projected = { sourceEntry: AnyEntry; messages: any[] };

export interface WarmPlan {
  /** First entry kept verbatim after the compaction. */
  firstKeptEntryId: string;
  /** Short description of the boundary for the model ("everything before ..."). */
  boundaryHint: string;
  /** Estimated tokens before the boundary and from it on. */
  summarizedTokens: number;
  keptTokens: number;
}

/** Rough token estimate in Pi's style (chars / 4). */
export function estimateMessageTokens(m: any): number {
  const c = m?.content;
  let chars = 0;
  if (typeof c === "string") chars = c.length;
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (b?.type === "text") chars += b.text?.length ?? 0;
      else if (b?.type === "thinking") chars += b.thinking?.length ?? 0;
      else if (b?.type === "toolCall") chars += JSON.stringify(b.arguments ?? {}).length + (b.name?.length ?? 0);
      else if (b?.type === "image") chars += 4800;
    }
  }
  if (m?.role === "compactionSummary" || m?.role === "branchSummary") chars += (m.summary?.length ?? 0);
  return Math.ceil(chars / 4);
}

function isCutPoint(p: Projected): boolean {
  if (p.sourceEntry.type === "compaction") return false;
  // Never cut at a tool result: it must stay with its call.
  return p.messages.some(m => m.role === "user" || m.role === "assistant" || m.role === "custom"
    || m.role === "bashExecution" || m.role === "branchSummary");
}

/**
 * Pick the cut: walk back from the end until keepRecentTokens is reached, then move forward to the
 * nearest valid cut point. Mirrors Pi's own rule, but on the projected (edit-aware) entries.
 * Returns undefined when there is nothing worth summarizing.
 */
export function planWarmCompaction(projected: Projected[], keepRecentTokens = 20_000): WarmPlan | undefined {
  // Start after the newest compaction's own summary (its checkpoint is index 0 when present).
  const start = projected[0]?.sourceEntry.type === "compaction" ? 1 : 0;
  const cuts: number[] = [];
  for (let i = start; i < projected.length; i++) if (isCutPoint(projected[i])) cuts.push(i);
  if (cuts.length === 0) return undefined;
  let acc = 0, cut = -1;
  for (let i = projected.length - 1; i >= start; i--) {
    const t = projected[i].messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
    if (t === 0) continue;
    acc += t;
    if (acc >= keepRecentTokens) { cut = cuts.find(c => c >= i) ?? cuts[cuts.length - 1]; break; }
  }
  if (cut <= start) return undefined; // everything fits in the kept tail
  const before = projected.slice(0, cut).reduce((s, p) => s + p.messages.reduce((a, m) => a + estimateMessageTokens(m), 0), 0);
  const after = projected.slice(cut).reduce((s, p) => s + p.messages.reduce((a, m) => a + estimateMessageTokens(m), 0), 0);
  const first = projected[cut];
  const keptMessages = projected.slice(cut).reduce((n, p) => n + p.messages.length, 0);
  return { firstKeptEntryId: first.sourceEntry.id, boundaryHint: describeBoundary(first.messages, keptMessages),
    summarizedTokens: before, keptTokens: after };
}

/**
 * Say where the kept tail starts, in words the model can match against what it sees: the message's
 * role, its opening text if it has any, otherwise its first tool call; plus how many messages from
 * the end. A reply that opens with thinking or a tool call has no text, so text alone isn't enough.
 */
export function describeBoundary(messages: any[], keptMessages: number): string {
  const msg = messages.find(m => m.role === "user" || m.role === "assistant" || m.role === "custom") ?? messages[0];
  const blocks = Array.isArray(msg?.content) ? msg.content : [{ type: "text", text: String(msg?.content ?? "") }];
  const text = String(blocks.find((b: any) => b?.type === "text" && b.text?.trim())?.text ?? "").replace(/\s+/g, " ").trim();
  const call = blocks.find((b: any) => b?.type === "toolCall");
  const role = msg?.role === "custom" ? "user" : msg?.role ?? "message";
  let what: string;
  if (text) what = `the ${role} message that begins "${text.slice(0, 100)}${text.length > 100 ? "…" : ""}"`;
  else if (call) {
    const arg = JSON.stringify(call.arguments ?? {}).replace(/\s+/g, " ").slice(0, 80);
    what = `the ${role} message that calls the ${call.name} tool (${arg})`;
  } else what = `the ${role} message`;
  return `${what}, which is message ${keptMessages} counting back from the end (just before this instruction)`;
}

/** The hidden instruction appended to the cached context. */
export function checkpointRequest(plan: WarmPlan, focus?: string): string {
  return `${REQUEST_MARKER}
This is a context-compaction step, not a task. Do not call any tools. Reply with text only.

Everything in this conversation before ${plan.boundaryHint} (about ${Math.round(plan.summarizedTokens / 1000)}k tokens) will be replaced by your reply. That message and everything after it (about ${Math.round(plan.keptTokens / 1000)}k tokens) stays verbatim, so don't repeat it.

Write a structured checkpoint that another instance of you will use to continue the work. You can see the full history, including complete tool output: keep exact file paths, commands, function names, IDs, numbers and error messages that will still matter. For finished work, keep its result, not just that it finished: counts, pass/fail figures, timings, commit IDs, and the cause found by any investigation. Keep any command needed to resume paused work, verbatim. Fold any earlier checkpoint summary in. Drop what no longer matters.${focus ? `\n\nAdditional focus: ${focus}` : ""}

Use exactly this format:

${CHECKPOINT_FORMAT}`;
}

/** Text of an assistant message, or undefined if it contains tool calls (a failed checkpoint). */
export function checkpointText(message: any): { text?: string; error?: string } {
  if (message?.role !== "assistant") return { error: "no assistant reply" };
  if (message.stopReason === "error" || message.stopReason === "aborted") return { error: message.errorMessage || `reply ${message.stopReason}` };
  if (message.stopReason === "length") return { error: "the checkpoint hit the output limit and is incomplete" };
  const blocks = Array.isArray(message.content) ? message.content : [];
  if (blocks.some((b: any) => b?.type === "toolCall")) return { error: "the model called a tool instead of writing the checkpoint" };
  const text = blocks.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n").trim();
  if (!text.includes("## Goal") || !text.includes("## Next Steps")) return { error: "the reply is not in checkpoint format" };
  return { text };
}
