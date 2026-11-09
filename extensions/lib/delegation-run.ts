import { isDeepStrictEqual } from "node:util";
import type * as Pi from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { workerThinking } from "./worker-model.ts";
import { workerTools, type WorkerToolSDK } from "./delegation-tools.ts";

type SDK = WorkerToolSDK & Pick<typeof Pi, "SessionManager" | "SettingsManager" | "createAgentSession" | "convertToLlm">;
export type ParentSnapshot = {
  sessionId: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  payload?: Record<string, any>;
  toolInfo?: Pick<Pi.ToolInfo, "name" | "exposure" | "namespace">[];
};

// Request-local provider controls must match, not merely the serialized conversation.
export function sharedPayload(parent: Record<string, any>, child: Record<string, any>, thinkingChanged = false) {
  if (!Array.isArray(parent.input) || !Array.isArray(child.input) ||
      !isDeepStrictEqual(parent.input, child.input.slice(0, parent.input.length))) {
    throw new Error("Shared delegation cannot preserve this parent's input prefix.");
  }
  const controls = (payload: Record<string, any>) => {
    const value = Object.fromEntries(Object.entries(payload)
      .filter(([key, value]) => !["input", "prompt_cache_key"].includes(key) && value !== undefined));
    if (thinkingChanged) {
      // An explicit effort change may also add/remove the serializer's automatic
      // reasoning summary and encrypted-content include when crossing "off".
      const { effort: _effort, summary, ...other } = value.reasoning ?? {};
      value.reasoning = { ...other, ...(summary && summary !== "auto" ? { summary } : {}) };
      const include = value.include?.filter((item: string) => item !== "reasoning.encrypted_content");
      if (include?.length) value.include = include;
      else delete value.include;
    }
    return value;
  };
  if (!isDeepStrictEqual(controls(parent), controls(child))) {
    throw new Error("Shared delegation request controls differ from the parent; no fallback was attempted.");
  }
  // Also preserve the absence of a key: never silently enable caching.
  const result = { ...child };
  if (Object.hasOwn(parent, "prompt_cache_key")) result.prompt_cache_key = parent.prompt_cache_key;
  else delete result.prompt_cache_key;
  return result;
}

export type InvokedBy = "model" | "user";
export type Progress = { startedAt: number; requests: number; tools: number; recent: string[]; sessionFile: string };

const clip = (s: string, n = 72) => { const line = s.replace(/\s+/g, " ").trim(); return line.length > n ? `${line.slice(0, n - 1)}…` : line; };
/** One readable line per worker tool call, e.g. "bash git status" or "edit notes.md". */
export function describeTool(name: string, args: any) {
  const main = args?.command ?? args?.path ?? args?.pattern ?? "";
  return clip(`${name} ${typeof main === "string" ? main : ""}`);
}

export type Budget = { requests: number; minutes: number };
const budgetLine = (b?: Budget) => b ? `\nBudget: ${b.requests} model requests and ${b.minutes} minutes. Write any status the assignment asks for early, and keep the workspace consistent (compiling, no half-made edits) between steps; you will be told once when the budget is nearly spent.` : "";

/** Sent once near the limit; the worker should stop starting work and report. */
export const wrapUpMessage = (requestsLeft: number, secondsLeft: number) =>
  `Budget nearly spent (${requestsLeft} request(s), about ${Math.max(0, Math.round(secondsLeft / 60))} min left). Do not start new work. Finish or revert any half-done edit so the workspace is consistent, record status where the assignment asked, then give your final report: what is done, what remains, and checks actually run.`;

export const workerInstructions = (task: string, invokedBy: InvokedBy = "model", unavailable: string[] = [], budget?: Budget) => `You are a delegated worker in the same workspace, with the parent's conversation as context.
Do the following assignment directly using your tools. Follow its scope; avoid unrelated changes.
The assignment may be brief: the conversation above is your context, so infer the specifics from it.
The parent has already delegated to you and is waiting. Earlier instructions to invoke delegate were for the parent and are already satisfied; do not repeat them.
Perform the assignment below yourself using your local tools. Do not delegate again. Your tool transcript stays here.
Local file/shell tools and codemode execute independently here; delegate is disabled.${unavailable.length ? ` These inherited extension tools are unavailable here: ${unavailable.join(", ")}. Ask the parent to run them if needed.` : ""}
Return a concise result: what you did/found, files changed, actual checks, and anything unfinished.
Do not return full files or diffs unless the assignment specifically requires them.${budgetLine(budget)}

${invokedBy === "user" ? "The user gave you this assignment directly (verbatim):" : "Assignment:"}
${task}`;

function addUsage(total: Usage, usage: Usage) {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += usage[key];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += usage.cost[key];
  for (const key of ["reasoning", "cacheWrite1h"] as const) {
    if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key]!;
  }
}

const pathOf = (name: string, args: any): string | undefined =>
  (name === "edit" || name === "write") && typeof args?.path === "string" ? args.path : undefined;
const firstText = (content: any) => Array.isArray(content)
  ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n") : "";

/** Evidence for a run that did not finish: what it touched, what failed, its last words. */
export function incompleteEvidence(files: string[], errors: string[], lastText: string, sessionId: string) {
  const lines: string[] = [];
  if (files.length) lines.push(`Files edited: ${files.slice(0, 8).join(", ")}${files.length > 8 ? ` (+${files.length - 8})` : ""}`);
  else lines.push("Files edited: none (by edit/write; bash changes are not tracked)");
  for (const e of errors.slice(0, 5)) lines.push(`Tool error: ${e}`);
  if (errors.length > 5) lines.push(`(+${errors.length - 5} more tool errors)`);
  if (lastText) lines.push(`Last worker message (not a final report):\n${lastText.slice(0, 1500)}${lastText.length > 1500 ? "…" : ""}`);
  lines.push(`Worker session id: ${sessionId}`);
  return lines.join("\n");
}

export const MAX_CONTINUATIONS = 5;

/** Request controls of an OpenAI Responses payload: everything but the conversation. */
export const payloadControls = (payload: Record<string, any>) =>
  Object.fromEntries(Object.entries(payload).filter(([key, value]) => key !== "input" && value !== undefined));
export const defaultContinueTask = "Continue the assignment from where you stopped. Check the workspace state first (e.g. git status), finish or cleanly revert any half-done edit, then complete the remaining work and report.";

/** Why a saved worker cannot be continued under this parent, or null if it can. */
export function continuationRefusal(entries: any[], snapshot: Pick<ParentSnapshot, "sessionId" | "model">): string | null {
  const origin = entries.find(e => e.type === "custom" && e.customType === "delegate-origin")?.data;
  if (!origin) return "That session is not a delegate worker.";
  if (origin.parentSessionId !== snapshot.sessionId) return "That worker belongs to a different parent session.";
  if (origin.provider !== snapshot.model.provider || origin.model !== snapshot.model.id) {
    return `That worker ran on ${origin.provider}/${origin.model}; switch back to it to continue.`;
  }
  if (["openai-responses", "openai-codex-responses"].includes(snapshot.model.api) &&
      !entries.findLast(e => e.type === "custom" && e.customType === "delegate-result")?.data?.controls) {
    return "That OpenAI worker predates continuation support (no saved request controls). Start a new task instead.";
  }
  const done = entries.filter(e => e.type === "custom" && e.customType === "delegate-continue").length;
  if (done >= MAX_CONTINUATIONS) return `That worker has already been continued ${done} times; split the remaining work into a new task.`;
  return null;
}

/** One ordinary SDK worker. No staging, directory permissions, parent tool proxies or router. */
export async function runDelegate(sdk: SDK, options: {
  snapshot: ParentSnapshot;
  task: string;
  thinkingLevel?: ThinkingLevel;
  cwd: string;
  evidenceDir: string;
  modelRuntime: Pi.ModelRuntime;
  signal?: AbortSignal;
  maxTurns?: number;
  timeoutMs?: number;
  invokedBy?: InvokedBy;
  /** Continue a saved worker session instead of starting a new one. */
  continueFrom?: string;
  onProgress?: (progress: Progress) => void;
  origin?: { parentRequestId: string | null; parentToolCallId: string; guidanceId: string; invokedBy?: InvokedBy };
}) {
  const { snapshot, cwd, task, modelRuntime, signal } = options;
  if (!task.trim()) throw new Error("A delegation task is required.");
  signal?.throwIfAborted();
  const resumed = options.continueFrom ? sdk.SessionManager.open(options.continueFrom, options.evidenceDir) : undefined;
  const resumedOrigin = resumed?.getEntries().find(e => e.type === "custom" && e.customType === "delegate-origin") as any;
  if (resumed) {
    const refusal = continuationRefusal(resumed.getEntries(), snapshot);
    if (refusal) throw new Error(refusal);
  }
  const thinkingLevel = resumed ? resumedOrigin.data.thinkingLevel as ThinkingLevel
    : workerThinking(snapshot.model, snapshot.thinkingLevel, options.thinkingLevel);
  const responses = ["openai-responses", "openai-codex-responses"].includes(snapshot.model.api);
  if (responses && !resumed && !snapshot.payload) throw new Error("OpenAI parent request payload was not captured; no worker was started.");
  // A continued OpenAI worker is held to its own saved controls (incl. cache key), not the parent's.
  const savedControls = resumed?.getEntries()
    .findLast(e => e.type === "custom" && e.customType === "delegate-result" && (e as any).data?.controls) as any;
  let lastControls: Record<string, any> | undefined;
  if (!resumed && !snapshot.messages.some(message => message.role === "system")) throw new Error("No complete parent context captured.");
  const maxTurns = options.maxTurns ?? 30;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Invalid worker limits.");
  }
  // Persist the same LLM projection the provider receives, not Pi-only summary
  // message roles that appendMessage does not accept as stored transcript entries.
  // A continued worker's baseline is its own saved conversation: the original
  // parent prefix plus everything it did, so the prefix check still applies.
  const inherited = resumed
    ? sdk.convertToLlm(structuredClone(resumed.buildSessionContext().messages))
    : sdk.convertToLlm(structuredClone(snapshot.messages));
  const manager = resumed ?? sdk.SessionManager.create(cwd, options.evidenceDir);
  if (resumed) {
    const index = resumed.getEntries().filter(e => e.type === "custom" && e.customType === "delegate-continue").length + 1;
    manager.appendCustomEntry("delegate-continue", { index, task, parentSessionId: snapshot.sessionId, ...options.origin });
  } else {
    manager.appendModelChange(snapshot.model.provider, snapshot.model.id);
    manager.appendThinkingLevelChange(thinkingLevel);
    // Keep the validation baseline independent of mutable session/agent objects.
    for (const message of inherited) manager.appendMessage(structuredClone(message));
    manager.appendCustomEntry("delegate-origin", { parentSessionId: snapshot.sessionId,
      inheritedMessages: inherited.length, task,
      provider: snapshot.model.provider, model: snapshot.model.id, thinkingLevel,
      parentThinkingLevel: snapshot.thinkingLevel, validation: responses ? "responses-wire-prefix" : "logical-context-prefix",
      ...options.origin });
  }
  const continuation = resumed ? manager.getEntries().filter(e => e.type === "custom" && e.customType === "delegate-continue").length : 0;
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off", transport: "sse" });
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  let session: Pi.AgentSession | undefined;
  let reason: string | undefined;
  let turns = 0;
  let toolErrors = 0;
  let last: any;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let softTimer: ReturnType<typeof setTimeout> | undefined;
  const files: string[] = [];
  const errors: string[] = [];
  const pending = new Map<string, string>();
  let lastText = "";
  let wrapUp = "not-needed" as "not-needed" | "sent";
  // Soft limit: three requests before the cap, or 80% of the time limit.
  const softTurns = Math.max(1, maxTurns - 3);
  const graceMs = Math.min(90_000, Math.floor(timeoutMs * 0.2));
  const startedAt = Date.now();
  const sendWrapUp = () => {
    if (wrapUp === "sent" || !session) return;
    wrapUp = "sent";
    const left = Math.max(0, maxTurns - turns);
    void session.steer(wrapUpMessage(left, (timeoutMs - (Date.now() - startedAt)) / 1000)).catch(() => {});
  };
  let ticker: ReturnType<typeof setInterval> | undefined;
  const progress: Progress = { startedAt: Date.now(), requests: 0, tools: 0, recent: [], sessionFile: "" };
  // Display only; a renderer failure must never affect the worker.
  const notify = () => { try { options.onProgress?.({ ...progress, recent: [...progress.recent] }); } catch {} };
  const stop = (message: string) => {
    reason ??= message;
    session?.agent.abort();
  };
  const abort = () => stop("Cancelled; completed edits remain in the workspace.");
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const stream: Pi.ModelRuntime["streamSimple"] = (model, context, requestOptions) => {
      if (++turns > maxTurns) throw new Error(`Worker stopped after ${maxTurns} requests; edits remain.`);
      if (turns >= softTurns && maxTurns > 3) sendWrapUp();
      progress.requests = turns; notify();
      if (model.provider !== snapshot.model.provider || model.id !== snapshot.model.id || model.api !== snapshot.model.api) {
        throw new Error("Worker provider/model changed; no fallback was attempted.");
      }
      if ((!responses || resumed) && !isDeepStrictEqual(inherited, context.messages.slice(0, inherited.length))) {
        throw new Error("Worker cannot preserve the parent's logical context prefix.");
      }
      return modelRuntime.streamSimple(model, context, requestOptions);
    };
    // Bind everything else to the original runtime (including private-field methods).
    // Count at dispatch, not onPayload: custom providers may omit payload hooks.
    const workerRuntime = new Proxy(modelRuntime, { get(target, key) {
      if (key === "streamSimple") return stream;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const tooling = await workerTools(sdk, cwd, inherited, settingsManager, snapshot.toolInfo);
    const created = await sdk.createAgentSession({ cwd, model: snapshot.model,
      thinkingLevel, modelRuntime: workerRuntime, sessionManager: manager,
      resourceLoader: tooling.loader, tools: tooling.tools, settingsManager,
    });
    session = created.session;
    if (created.modelFallbackMessage || session.model?.id !== snapshot.model.id ||
        session.model?.provider !== snapshot.model.provider || session.thinkingLevel !== thinkingLevel) {
      throw new Error("Worker model/thinking differs from the requested setting; no fallback was attempted.");
    }
    if (responses) session.agent.onPayload = payload => {
      let out: Record<string, any>;
      if (savedControls) {
        // Same wire controls as the worker's earlier requests; the conversation is
        // checked above as a logical prefix of the worker's own saved transcript.
        const saved = savedControls.data.controls as Record<string, any>;
        const { prompt_cache_key: _k, ...want } = saved;
        const { prompt_cache_key: _c, ...got } = payloadControls(payload as Record<string, any>);
        if (!isDeepStrictEqual(want, got)) throw new Error("Continued worker request controls differ from its earlier requests; no fallback was attempted.");
        out = { ...(payload as Record<string, any>) };
        if (Object.hasOwn(saved, "prompt_cache_key")) out.prompt_cache_key = saved.prompt_cache_key;
        else delete out.prompt_cache_key;
      } else {
        out = sharedPayload(snapshot.payload!, payload as Record<string, any>, thinkingLevel !== snapshot.thinkingLevel);
      }
      lastControls = payloadControls(out);
      return out;
    };
    progress.sessionFile = manager.getSessionFile() ?? "";
    session.subscribe(event => {
      if (event.type === "tool_execution_start") {
        progress.tools++;
        progress.recent = [...progress.recent, describeTool(event.toolName, event.args)].slice(-5);
        const p = pathOf(event.toolName, event.args);
        if (p && !files.includes(p)) files.push(p);
        pending.set(event.toolCallId, event.toolName);
        notify();
      }
      if (event.type !== "message_end") return;
      if (event.message.role === "assistant") {
        last = event.message;
        const text = firstText(event.message.content).trim();
        if (text) lastText = text;
        addUsage(usage, event.message.usage);
      } else if (event.message.role === "toolResult") {
        // Includes nested calls recorded on a codemode result. A normal final
        // response does not prove the assignment succeeded; surface errors even
        // when the worker recovered and the run itself completed.
        if (event.message.isError) {
          const name = pending.get(event.message.toolCallId) ?? event.message.toolName;
          errors.push(`${name}: ${firstText(event.message.content).replace(/\s+/g, " ").trim().slice(0, 120)}`);
        }
        for (const c of event.message.nestedCalls?.calls ?? []) {
          if (c.status === "error") errors.push(`${(c as any).name ?? "nested"} (in codemode): ${String((c as any).error ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
        }
        toolErrors += Number(Boolean(event.message.isError));
        toolErrors += event.message.nestedCalls?.calls.filter(call => call.status === "error").length ?? 0;
        if (event.message.usage) addUsage(usage, event.message.usage);
      }
    });
    if (signal?.aborted) abort();
    if (reason) throw new Error(reason);
    timer = setTimeout(() => stop("Worker time limit reached; completed edits remain."), timeoutMs);
    if (timeoutMs > graceMs * 2) softTimer = setTimeout(sendWrapUp, Math.min(Math.floor(timeoutMs * 0.8), timeoutMs - graceMs));
    if (options.onProgress) { notify(); ticker = setInterval(notify, 1000); }
    const budget = { requests: maxTurns, minutes: Math.round(timeoutMs / 60_000) };
    await session.prompt(resumed
      ? `Continuation ${continuation} of ${MAX_CONTINUATIONS} of the assignment above. Budget: ${budget.requests} model requests and ${budget.minutes} minutes.\n\n${task}`
      : workerInstructions(task, options.invokedBy, tooling.unavailable, budget), { expandPromptTemplates: false });
    if (last?.stopReason !== "stop") reason ??= last?.errorMessage ?? `Worker ended with ${last?.stopReason ?? "no final response"}.`;
  } catch (error) {
    reason ??= error instanceof Error ? error.message : String(error);
  } finally {
    if (timer) clearTimeout(timer);
    if (softTimer) clearTimeout(softTimer);
    if (ticker) clearInterval(ticker);
    signal?.removeEventListener("abort", abort);
    session?.dispose();
  }
  const report = last?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") ?? "";
  const file = manager.getSessionFile();
  const status = reason ? "incomplete" : "completed";
  const leafId = manager.getLeafId();
  manager.appendCustomEntry("delegate-result", { status, reason, usage, toolErrors, requests: Math.min(turns, maxTurns),
    wrapUp, files, errors: errors.slice(0, 20), workerLeafId: leafId,
    ...(responses && (lastControls ?? savedControls?.data.controls) ? { controls: lastControls ?? savedControls.data.controls } : {}) });
  const errorLines = errors.slice(0, 5).map(e => `  - ${e}`).join("\n");
  const warning = toolErrors ? `Worker recorded ${toolErrors} tool error(s); inspect its report before accepting the task.\n${!reason && errorLines ? errorLines + "\n" : ""}` : "";
  // A report only counts as final when the run completed; otherwise show evidence.
  const body = reason
    ? `${report && last?.stopReason === "stop" ? report.slice(0, 6000) + "\n\n" : ""}${incompleteEvidence(files, errors, report ? "" : lastText, manager.getSessionId())}`
    : report.slice(0, 6000) || "No final worker report; inspect the session before continuing.";
  const cut = !reason && report.length > 6000 ? "\n[Report truncated at 6000 characters; full text is the last assistant message in the worker session.]" : "";
  const canContinue = continuation < MAX_CONTINUATIONS && (!responses || lastControls || savedControls);
  const hint = reason && canContinue
    ? `\nContinue with: delegate({ continue: "${manager.getSessionId()}" })` : "";
  const historyHint = `\nRead only this worker's own turns: delegate_history({ worker: "${manager.getSessionId()}" })`;
  const text = `${reason ? `Worker incomplete: ${reason}${wrapUp === "sent" ? " (wrap-up warning was sent)" : ""}\n` : ""}${warning}${body}${cut}${hint}${historyHint}\n\nWorker session: ${file}`;
  return { content: [{ type: "text" as const, text }],
    details: { status, sessionId: manager.getSessionId(), sessionFile: file, requests: Math.min(turns, maxTurns),
      tools: progress.tools, toolErrors, wrapUp, files, continuation, elapsedMs: Date.now() - progress.startedAt,
      provider: snapshot.model.provider, model: snapshot.model.id, thinkingLevel }, usage, isError: Boolean(reason) };
}
