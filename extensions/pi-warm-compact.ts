import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { CUSTOM_TYPE, REQUEST_MARKER, checkpointRequest, checkpointText, planWarmCompaction, type WarmPlan } from "./lib/warm-compact.ts";
import { applyPlan, buildMap, editRequest, parsePlan, ruleEdits, sizes, type EditDraft, type MapItem } from "./lib/edit-compact.ts";

/**
 * Cache-warm compaction (docs/WARM_COMPACT.md).
 *
 * Pi's /compact sends a separate summary request that can't use the prompt cache. Here the
 * compaction request is the session's own next turn, so the whole cached context is reused.
 *
 * /warm-compact [focus]       (default; `edit` also accepted) edit compaction (mode C): nothing is summarized away. Old tool
 *                             output and long tool arguments shrink to placeholders by rule; the
 *                             model returns a small JSON plan to condense or fold old conversation
 *                             text. Everything is a `context_edit`, and `context_recall` restores
 *                             any original. Repeat runs leave earlier edits alone.
 * /warm-compact summary [focus]  the model writes a checkpoint summary (mode A′); old turns are
 *                             replaced by it, the last ~20k tokens stay verbatim. The fallback if
 *                             edit mode is refused.
 *
 * Both: a hidden instruction triggers one turn; tool calls are blocked during it (tools stay
 * declared so the prefix matches); at turn_end the instruction and the reply are hidden and the
 * result is written. Automatic compaction is untouched; this runs only when you ask.
 */

type Pending = { mode: "summary" | "edit"; plan: WarmPlan; startedAt: number; cut: number; start: number;
  rules?: Map<string, EditDraft>; items?: MapItem[]; realTokens?: number; scale: number };

/**
 * Real context size from the provider: the newest assistant reply's usage (input + cache read +
 * cache write + output), the same source Pi's footer and /compact use. Character counts miss the
 * system prompt, tool definitions, thinking signatures and replay data (90k of 269k in one run).
 */
function realContextTokens(projected: any[]): number | undefined {
  for (let i = projected.length - 1; i >= 0; i--) {
    for (const m of [...projected[i].messages].reverse()) {
      const u = m?.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted" ? m.usage : undefined;
      const total = u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0) : 0;
      if (total > 0) return total;
    }
  }
  return undefined;
}
/** Chat-only status line (a custom entry: shown in the transcript, never sent to the model). */
export const STATUS_TYPE = "pi-warm-compact-status";
type Status = { phase: "start" | "done" | "failed"; text: string };

export default function warmCompact(pi: ExtensionAPI) {
  let pending: Pending | undefined;

  pi.registerEntryRenderer<Status>(STATUS_TYPE, (entry, _options, theme) => {
    const d = entry.data;
    if (!d) return undefined;
    const color = d.phase === "failed" ? "error" : d.phase === "done" ? "success" : "dim";
    const box = new Box(1, 0);
    box.addChild(new Text(theme.fg(color as never, `warm-compact: ${d.text}`), 0, 0));
    return box;
  });
  const fmt = (n: unknown) => typeof n === "number" ? n.toLocaleString("en-US") : "?";
  const k = (n: number) => `${Math.round(n / 1000)}k`;

  const finish = (ctx: { ui: { notify(m: string, t?: "info" | "warning" | "error"): void } }, msg: string, type: "info" | "warning" | "error" = "info") => {
    pending = undefined;
    ctx.ui.notify(`warm-compact: ${msg}`, type);
  };

  pi.registerCommand("warm-compact", {
    description: "Cache-warm compaction: `/warm-compact [focus]` (edits, recallable) or `/warm-compact summary [focus]` (checkpoint summary). Research prototype.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (pending) return ctx.ui.notify("warm-compact: already running", "warning");
      if (!ctx.isIdle()) return ctx.ui.notify("warm-compact: wait until the agent is idle", "warning");
      const words = args.trim();
      const mode: Pending["mode"] = /^summary\b/i.test(words) ? "summary" : "edit";
      const focus = words.replace(/^(edit|summary)\b/i, "").trim() || undefined;
      const projected = ctx.sessionManager.buildSessionProjection().entries as any[];
      const plan = planWarmCompaction(projected, 20_000);
      if (!plan) return ctx.ui.notify("warm-compact: nothing to compact (the context fits in the kept tail)", "info");
      const cut = projected.findIndex(p => p.sourceEntry.id === plan.firstKeptEntryId);
      const start = projected[0]?.sourceEntry.type === "compaction" ? 1 : 0;
      // Character estimates split the context; the real total scales them to provider tokens.
      const realTokens = realContextTokens(projected);
      const estimated = plan.summarizedTokens + plan.keptTokens;
      const scale = realTokens && estimated > 0 ? realTokens / estimated : 1;
      pending = { mode, plan, startedAt: Date.now(), cut, start, realTokens, scale };
      const before = realTokens ? ` of ${k(realTokens)} in context` : "";
      const kr = (n: number) => k(n * scale);
      let request: string;
      if (mode === "edit") {
        const rules = ruleEdits(projected, start, cut);
        const items = buildMap(projected, start, cut);
        const s = sizes(projected, start, cut, rules);
        pending.rules = rules; pending.items = items;
        request = editRequest(plan.boundaryHint, items, s.before - s.after, focus);
        pi.appendEntry<Status>(STATUS_TYPE, { phase: "start", text: `edit mode${before}: rules shrink the older ~${kr(s.before)} to ~${kr(s.after)} (${rules.size} edits); asking the model for a plan over ${items.length} messages; keeping ~${kr(plan.keptTokens)} verbatim${focus ? ` (focus: ${focus})` : ""}` });
      } else {
        request = checkpointRequest(plan, focus);
        pi.appendEntry<Status>(STATUS_TYPE, { phase: "start", text: `asking for a checkpoint${before}: ~${kr(plan.summarizedTokens)} summarized inside the cached context, ~${kr(plan.keptTokens)} kept verbatim${focus ? ` (focus: ${focus})` : ""}` });
      }
      await pi.sendMessage({ customType: CUSTOM_TYPE, content: request, display: false,
        details: { firstKeptEntryId: plan.firstKeptEntryId, mode } }, { triggerTurn: true });
    },
  });

  // Restore what an edit hid or shortened: the raw entry is still in the session file.
  pi.registerTool({
    name: "context_recall", label: "Context recall",
    description: "Return the original text of an earlier session entry that compaction shortened (its placeholder names the id). Read-only.",
    parameters: Type.Object({ id: Type.String({ minLength: 4, maxLength: 64 }), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const entry: any = ctx.sessionManager.getEntry(params.id);
      if (!entry || entry.type !== "message") throw new Error(`no message entry ${params.id} in this session`);
      const m = entry.message;
      const parts: string[] = [];
      for (const b of Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }]) {
        if (b?.type === "text") parts.push(b.text);
        else if (b?.type === "toolCall") parts.push(`[tool call ${b.name}] ${JSON.stringify(b.arguments ?? {}, null, 1)}`);
        else if (b?.type === "image") parts.push("[image]");
      }
      const all = parts.join("\n");
      const offset = params.offset ?? 0, page = 20_000;
      const text = all.slice(offset, offset + page);
      const more = offset + page < all.length ? `\n[… ${all.length - offset - page} more chars; call again with offset ${offset + page}]` : "";
      return { content: [{ type: "text", text: `${m.role} entry ${params.id}:\n${text}${more}` }], details: { chars: all.length } };
    },
  });

  // The tools stay declared (removing them would change the cached prefix), so refuse any call.
  pi.on("tool_call", () => {
    if (!pending) return undefined;
    return { block: true, reason: "warm-compact: this turn must be text only (no tool calls)", terminate: true };
  });

  pi.on("turn_end", (event: any, ctx) => {
    if (!pending) return undefined;
    // The request is the custom message just before this assistant reply.
    const entries = ctx.sessionManager.getBranch();
    const replyIdx = entries.findIndex(e => e.id === event.messageEntryId);
    const request = [...entries.slice(0, replyIdx)].reverse().find((e: any) => e.type === "custom_message" && e.customType === CUSTOM_TYPE);
    if (!request || !String((request as any).content).includes(REQUEST_MARKER)) {
      finish(ctx, "could not find its own request in the session; nothing changed", "error");
      return undefined;
    }
    const p = pending;
    const hide = [
      { type: "context_edit" as const, targetId: request.id, replacement: null },
      { type: "context_edit" as const, targetId: event.messageEntryId, replacement: null },
      ...event.toolResultEntryIds.map((id: string) => ({ type: "context_edit" as const, targetId: id, replacement: null })),
    ];
    const usage = event.message.usage;
    const secs = Math.round((Date.now() - p.startedAt) / 1000);
    const numbers = `cache read ${fmt(usage?.cacheRead)}, cache write ${fmt(usage?.cacheWrite)}, input ${fmt(usage?.input)}, output ${fmt(usage?.output)}`;
    const hit = typeof usage?.cacheRead === "number" && typeof usage?.cacheWrite === "number" && usage.cacheRead > usage.cacheWrite;
    const cache = hit ? "Cache hit" : "Cache MISS (the prefix changed since the last turn)";
    const fail = (error: string) => {
      finish(ctx, `failed (${error}); the session is unchanged`, "error");
      // A provider refusal: don't retry the same request on the same context; use the summary mode or try later.
      const refused = /refus/i.test(error);
      const hint = refused ? " Provider refusal: don't retry this on the same point; use /warm-compact summary here, or try edit mode later at a different point." : "";
      return { entries: [...event.entries, ...hide,
        { type: "custom" as const, customType: STATUS_TYPE, data: { phase: "failed", text: `failed after ${secs}s (${error}); the session is unchanged. ${numbers}${hint}` } satisfies Status }],
        continue: false };
    };

    if (p.mode === "edit") {
      const m = event.message;
      if (m?.stopReason === "error" || m?.stopReason === "aborted") return fail(m.errorMessage || `reply ${m.stopReason}`);
      if (m?.stopReason === "length") return fail("the plan hit the output limit");
      if ((m?.content ?? []).some((b: any) => b?.type === "toolCall")) return fail("the model called a tool instead of writing the plan");
      const reply = (m?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
      const { ops, invalid, error } = parsePlan(reply);
      if (error || !ops) return fail(`unreadable plan: ${error}`);
      // Re-project: entries are unchanged up to the cut (the new turn only appended after it).
      const projected = ctx.sessionManager.buildSessionProjection().entries as any[];
      const cut = projected.findIndex(e => e.sourceEntry.id === p.plan.firstKeptEntryId);
      if (cut !== p.cut) return fail("the session changed during compaction");
      const applied = applyPlan(projected, p.start, cut, p.items!, ops, p.rules!);
      const { edits } = applied;
      const skipped = [...(invalid ?? []), ...applied.skipped];
      const s = sizes(projected, p.start, cut, edits);
      const after = p.realTokens ? Math.round((p.realTokens - (s.before - s.after) * p.scale) / 1000) : undefined;
      finish(ctx, `done in ${secs}s: ${numbers}`);
      return {
        entries: [...event.entries, ...hide, ...edits.values(),
          { type: "custom" as const, customType: STATUS_TYPE, data: { phase: "done",
            text: `edit mode done in ${secs}s. Older context ~${k(s.before * p.scale)} → ~${k(s.after * p.scale)}${after !== undefined ? ` (whole context ~${k(p.realTokens!)} → ~${after}k)` : ""}; ${edits.size} edits, ${ops.length} model ops${skipped.length ? `, ${skipped.length} skipped` : ""}; last ~${k(p.plan.keptTokens * p.scale)} verbatim. ${cache}: ${numbers}${skipped.length ? `\nSkipped: ${skipped.join("; ")}` : ""}` } satisfies Status }],
        continue: false,
      };
    }

    const { text, error } = checkpointText(event.message);
    if (error || !text) return fail(error ?? "empty reply");
    finish(ctx, `done in ${secs}s: ${numbers}`);
    return {
      entries: [...event.entries, ...hide,
        { type: "custom" as const, customType: STATUS_TYPE, data: { phase: "done", text: `done in ${secs}s. ${cache}: ${numbers}` } satisfies Status }, {
        type: "compaction" as const, summary: text, firstKeptEntryId: p.plan.firstKeptEntryId, usage,
        details: { mode: "warm", contextTokens: p.realTokens, summarizedTokens: Math.round(p.plan.summarizedTokens * p.scale),
          keptTokens: Math.round(p.plan.keptTokens * p.scale), seconds: secs },
      }],
      continue: false,
    };
  });

  pi.on("session_before_switch", () => { pending = undefined; });
}
