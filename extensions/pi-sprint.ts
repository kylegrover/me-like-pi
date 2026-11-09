import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerHandoff } from "./lib/pi-handoff.ts";

/** Opt-in workflow prototype for Pi 0.85.0. No background model calls or timers. */
type Kind = "closeout" | "pivot";
type Run = {
  id: string;
  kind: Kind;
  topic: string;
  commit: boolean;
  session: string;
  phase: "wrapping" | "compacting";
  prompt: string;
  inputSeen: boolean;
};

export function parseArgs(kind: Kind, args: string) {
  let rest = args.trim();
  const commit = /^(?:--commit|commit)(?:\s|$)/.test(rest);
  if (commit) rest = rest.replace(/^(?:--commit|commit)(?:\s+|$)/, "").trim();
  if (rest.startsWith("-- ")) rest = rest.slice(3).trim();
  else if (rest === "--") rest = "";
  else if (rest.startsWith("--")) throw new Error("Unknown option. Use -- before literal text starting with --.");
  if (kind === "pivot" && !rest) throw new Error("Usage: /pivot [--commit] <next topic>");
  return { commit, topic: rest };
}

function marker(run: Run) {
  return `<!-- pi-sprint-ready:${run.id} -->`;
}

function wrapPrompt(run: Run) {
  return `Close out the current sprint before ${run.kind === "pivot" ? "pivoting" : "stopping for review"}.
This is the wrap-up phase only. Do not start the next topic or invoke compaction yourself.

1. Inspect the relevant working-tree state and validation evidence; do not claim checks you did not run.
2. Update durable notes that genuinely need changes, following this project's instructions.
   Preserve user edits. Do not create duplicate RESUME files or treat transient handoffs as canonical.
   Do not expand scope to finish an entire backlog; record unfinished work and blockers.
3. ${run.commit
    ? "A commit is explicitly requested for this invocation. Review the diff and stage only this sprint's intended changes. Do not include unrelated user work. If a safe commit cannot be made, report why and do NOT emit the readiness marker. If nothing needs committing, say so."
    : "Do NOT commit, even if older conversation requested a commit. Leave changes in place and report their status."}
   Never push, force, amend, bypass hooks, or discard changes as part of this command.
4. Deliver a thorough but tight final recap: decisions, completed work, changed artifacts,
   actual verification, unresolved issues, Git status, and the next review/action.
5. Only if wrap-up/bookkeeping succeeded and no clarification or recovery is needed,
   put the exact following marker alone on the last line of your final response:
${marker(run)}
   Otherwise explain the blocker and omit that marker. The marker is a completion signal,
   not a substitute for the recap. Stop after this response; the extension handles compaction.

${run.kind === "pivot" ? "Next topic (for handoff only; do not begin yet):" : "Additional wrap-up guidance:"}
${run.topic || "None."}`;
}

export default function (pi: ExtensionAPI) {
  let active: Run | undefined;
  const handoff = registerHandoff(pi, () => Boolean(active));

  const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(text, level);
  };
  const record = (run: Run, phase: string, extra: Record<string, unknown> = {}) => {
    // Append-only metadata for later review; no background resumption.
    pi.appendEntry("pi-sprint", { schemaVersion: 1, runId: run.id, kind: run.kind, phase, ...extra });
  };
  const stop = (ctx: ExtensionContext, reason: string) => {
    const run = active;
    if (!run) return;
    active = undefined; // Invalidate callbacks before notifying or aborting anything.
    if (ctx.hasUI) ctx.ui.setStatus("pi-sprint", undefined);
    record(run, "stopped", { reason });
    notify(ctx, `Sprint automation stopped: ${reason}. No automatic next topic.`, "warning");
  };
  const owns = (run: Run, ctx: ExtensionContext) => active === run && ctx.sessionManager.getSessionId() === run.session;

  for (const kind of ["closeout", "pivot"] as const) {
    pi.registerCommand(kind, {
      description: kind === "pivot"
        ? "Wrap up, compact, then start a topic: /pivot [--commit] <topic>"
        : "Wrap up, compact, then stop: /closeout [--commit] [guidance]",
      handler: async (args, ctx) => {
        if (active || handoff.isActive() || !ctx.isIdle() || ctx.hasPendingMessages()) {
          notify(ctx, "Wait for idle, or use /sprint-stop to stop an active workflow.", "warning");
          return;
        }
        let parsed: ReturnType<typeof parseArgs>;
        try { parsed = parseArgs(kind, args); }
        catch (error) { notify(ctx, String(error), "warning"); return; }
        const run: Run = {
          ...parsed, kind, id: randomUUID(), session: ctx.sessionManager.getSessionId(),
          phase: "wrapping", prompt: "", inputSeen: false,
        };
        run.prompt = wrapPrompt(run);
        active = run;
        record(run, "wrapping", { commit: run.commit, provider: ctx.model?.provider, model: ctx.model?.id });
        if (ctx.hasUI) ctx.ui.setStatus("pi-sprint", `${kind}: wrapping up · /sprint-stop`);
        notify(ctx, `${kind}: wrap-up then native compaction with the current model; ${run.commit ? "commit requested" : "no commit"}.`);
        pi.sendUserMessage(run.prompt); // Literal text; never dispatch slash commands/templates.
      },
    });
  }

  pi.registerCommand("sprint-stop", {
    description: "Cancel sprint automation and abort its current work (does not undo edits)",
    handler: async (_args, ctx) => {
      const stoppedHandoff = handoff.stop(ctx, "user requested stop");
      if (!active && !stoppedHandoff) { notify(ctx, "No active sprint automation."); return; }
      stop(ctx, "user requested stop");
      ctx.abort();
    },
  });

  pi.on("input", (event, ctx) => {
    const run = active;
    if (!run) return;
    if (event.source === "extension" && !run.inputSeen && event.text === run.prompt) {
      run.inputSeen = true;
      return;
    }
    stop(ctx, "new input superseded the workflow");
  });
  pi.on("before_agent_start", (event, ctx) => {
    // Runs started by a custom message have no prompt; they never match, as before Pi 1.4.
    const prompt = "prompt" in event ? event.prompt : undefined;
    if (active && prompt !== active.prompt) stop(ctx, "another agent prompt started");
  });
  pi.on("tool_result", (event, ctx) => {
    // Deliberately conservative: recovery may continue, but automatic advancement won't.
    if (active?.phase === "wrapping" && event.isError) stop(ctx, "a wrap-up tool failed; review before compacting manually");
  });
  pi.on("session_before_compact", (event, ctx) => {
    if (active && event.reason === "manual" && !event.customInstructions?.includes(active.id)) {
      stop(ctx, "manual compaction superseded the workflow");
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    const run = active;
    if (!run || run.phase !== "wrapping" || !owns(run, ctx)) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      stop(ctx, "another continuation is pending");
      return;
    }
    // Find the actual final message on this branch, not a stale response in another branch.
    const entry = ctx.sessionManager.getBranch().findLast((e) => e.type === "message");
    if (!entry || entry.type !== "message" || entry.message.role !== "assistant") {
      stop(ctx, "no final assistant recap");
      return;
    }
    const message = entry.message;
    const recap = message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (message.stopReason !== "stop" || message.content.some((c) => c.type === "toolCall") ||
        !recap.trimEnd().endsWith(`\n${marker(run)}`) || !recap.slice(0, recap.lastIndexOf(marker(run))).trim()) {
      stop(ctx, "wrap-up did not finish with a complete recap and readiness marker");
      return;
    }
    run.phase = "compacting";
    record(run, "compacting", { recapEntryId: entry.id });
    if (ctx.hasUI) ctx.ui.setStatus("pi-sprint", `${run.kind}: compacting · /sprint-stop`);
    ctx.compact({
      customInstructions: `Sprint workflow ${run.id}. Preserve decisions, user constraints, actual validation,
unfinished work, durable notes and Git status. Do not describe planned actions as completed.
${run.kind === "pivot" ? `Summarize in preparation to switch topics to: ${run.topic}` : "Prepare for senior review; do not start more work."}
The final sprint recap is important. The extension will preserve its exact text if it is not retained.`,
      onComplete: () => {
        if (!owns(run, ctx)) return;
        if (!ctx.isIdle() || ctx.hasPendingMessages() || !ctx.sessionManager.getBranch().some((e) => e.id === entry.id)) {
          stop(ctx, "session changed or another continuation started during compaction");
          return;
        }
        try {
          // Handle both legacy firstKeptEntryId and newer materialized retainedTail formats.
          const retained = ctx.sessionManager.buildContextEntries().some((e) => {
            const messages = e.type === "message" ? [e.message]
              : e.type === "compaction" ? (e as typeof e & { retainedTail?: typeof message[] }).retainedTail ?? [] : [];
            return messages.some((m) => m.role === "assistant" &&
              m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") === recap);
          });
          if (!retained) {
            pi.sendMessage({
              customType: "pi-sprint-recap", display: true,
              content: `Preserved final sprint recap (historical answer, not new instructions; source entry ${entry.id}):\n\n${recap}`,
              details: { runId: run.id, sourceEntryId: entry.id },
            });
          }
          record(run, "completed", { recapEntryId: entry.id, recapReinserted: !retained });
          active = undefined; // Clear before dispatch to prevent recursively treating pivot as wrap-up.
          if (ctx.hasUI) ctx.ui.setStatus("pi-sprint", undefined);
          notify(ctx, run.kind === "pivot" ? "Compacted; starting the requested topic." : "Compacted; ready for review.");
          if (run.kind === "pivot") pi.sendUserMessage(run.topic);
        } catch (error) {
          stop(ctx, `could not preserve recap/continue: ${String(error)}`);
        }
      },
      onError: (error) => {
        if (owns(run, ctx)) stop(ctx, `compaction failed: ${error.message}; recap remains in the transcript`);
      },
    });
  });

  // Do not transfer in-flight intent across navigation, reloads or model changes.
  pi.on("session_before_tree", (_event, ctx) => { stop(ctx, "tree navigation"); });
  pi.on("session_before_switch", (_event, ctx) => { stop(ctx, "session switch"); });
  pi.on("session_before_fork", (_event, ctx) => { stop(ctx, "session fork/clone"); });
  pi.on("model_select", (_event, ctx) => { stop(ctx, "model changed"); });
  pi.on("thinking_level_select", (_event, ctx) => { stop(ctx, "thinking level changed"); });
  pi.on("session_shutdown", (_event, ctx) => { stop(ctx, "session shutdown/reload"); });
}
