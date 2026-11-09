import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Auto-continue after a Claude plan usage limit resets, like Claude Code does.
 *
 * The claude-code adapter marks a limit-hit turn with a `claude-code.usage-limit` diagnostic
 * carrying `resetsAt` (unix seconds). When the run settles on such an error, this waits until
 * the reset and sends one "continue" turn. By default only when the resume still lands inside
 * the prompt-cache window measured from the last successful Claude response, so the resume
 * reuses cache instead of re-reading the whole context. Typing anything, Esc, switching
 * provider or `/autocontinue off` cancels. While limited, compaction is skipped (it would
 * only hit the same limit).
 */

export const DIAGNOSTIC = "claude-code.usage-limit";
export const CUSTOM_TYPE = "pi-autocontinue";
const WIDGET = "pi-autocontinue";
/** Claude Code caches with a 1-hour TTL here; keep a margin for clock skew and the request itself. */
export const CACHE_WINDOW_MS = 60 * 60_000;
const MARGIN_MS = 2 * 60_000;
/** Resume a little after the reset so the window has really rolled over. */
export const RESUME_DELAY_MS = 20_000;
/** A second try if the first resume lands a moment early and hits the same window. */
const MAX_ATTEMPTS_PER_RESET = 2;

export type Mode = "cache" | "always" | "off";
type Limit = { resetsAt: number; limitType?: string; provider: string; model: string };
type Clock = { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown; clearInterval(id: unknown): void };

const realClock: Clock = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: id => clearTimeout(id as never),
  setInterval: (f, ms) => setInterval(f, ms), clearInterval: id => clearInterval(id as never) };

export function usageLimitOf(message: any): Limit | undefined {
  if (message?.role !== "assistant" || message.stopReason !== "error") return undefined;
  const diag = (message.diagnostics ?? []).findLast?.((d: any) => d?.type === DIAGNOSTIC);
  const resetsAt = Number(diag?.details?.resetsAt);
  if (!diag || !Number.isFinite(resetsAt) || resetsAt <= 0) return undefined;
  return { resetsAt, limitType: diag.details.limitType, provider: message.provider, model: message.model };
}

const clockText = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const waitText = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function createAutoContinue(clock: Clock = realClock, initialMode: Mode = parseMode(process.env.PI_AUTOCONTINUE) ?? "cache") {
  return function (pi: ExtensionAPI) {
    let mode: Mode = initialMode;
    let limit: Limit | undefined;          // the active, unexpired limit
    let unknownLimit = false;               // limit hit with no reset time: skip compaction, don't auto-continue
    let lastSuccessAt: number | undefined; // last good response from the limited provider
    let timer: unknown, ticker: unknown, ctxRef: ExtensionContext | undefined, unsubscribeKeys: (() => void) | undefined;
    const attempts = new Map<number, number>();

    /** A message timestamp from the last 6 hours, else undefined (synthetic/clock-skewed values). */
    const plausible = (ts: unknown) => typeof ts === "number" && ts <= clock.now() && ts > clock.now() - 6 * 3600_000 ? ts : undefined;
    const limited = () => !!limit && clock.now() < limit.resetsAt * 1000;
    const resumeAt = (l: Limit) => l.resetsAt * 1000 + RESUME_DELAY_MS;

    function clearWait(reason?: string) {
      if (timer !== undefined) clock.clearTimeout(timer);
      if (ticker !== undefined) clock.clearInterval(ticker);
      timer = ticker = undefined;
      unsubscribeKeys?.(); unsubscribeKeys = undefined;
      if (ctxRef?.hasUI) {
        ctxRef.ui.setWidget(WIDGET, undefined);
        if (reason) ctxRef.ui.notify(`Auto-continue cancelled (${reason}).`, "info");
      }
    }

    function render() {
      if (!ctxRef?.hasUI || !limit || timer === undefined) return;
      const at = resumeAt(limit);
      ctxRef.ui.setWidget(WIDGET, [`⏸ Claude usage limit — auto-continue at ${clockText(at)} (in ${waitText(at - clock.now())}). ` +
        "Esc or type to cancel."], { placement: "aboveEditor" });
    }

    /** Why we won't auto-continue, or undefined if we will. */
    function refusal(l: Limit): string | undefined {
      if (mode === "off") return "auto-continue is off (/autocontinue on)";
      if ((attempts.get(l.resetsAt) ?? 0) >= MAX_ATTEMPTS_PER_RESET) return "already resumed for this reset";
      if (mode === "always") return undefined;
      const from = lastSuccessAt ?? clock.now();
      if (resumeAt(l) - from > CACHE_WINDOW_MS - MARGIN_MS) {
        return `reset is past the ~1 h prompt-cache window (/autocontinue always to wait anyway)`;
      }
      return undefined;
    }

    function arm(l: Limit, ctx: ExtensionContext) {
      clearWait();
      ctxRef = ctx;
      const why = refusal(l);
      if (why) {
        if (ctx.hasUI) ctx.ui.notify(`Not auto-continuing: ${why}.`, "info");
        return;
      }
      timer = clock.setTimeout(() => fire(l), Math.max(0, resumeAt(l) - clock.now()));
      if (ctx.hasUI) {
        ticker = clock.setInterval(render, 1000);
        unsubscribeKeys = ctx.ui.onTerminalInput((data: string) => {
          if (data === "\u001b") clearWait("Esc");
          return undefined;
        });
      }
      render();
    }

    function fire(l: Limit) {
      const ctx = ctxRef;
      clearWait();
      if (!ctx || limit !== l) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return; // the user is already doing something
      if (ctx.model && ctx.model.provider !== l.provider) return;
      attempts.set(l.resetsAt, (attempts.get(l.resetsAt) ?? 0) + 1);
      pi.appendEntry(CUSTOM_TYPE, { resumedAt: clock.now(), resetsAt: l.resetsAt, limitType: l.limitType });
      pi.sendMessage({ customType: CUSTOM_TYPE, display: true,
        content: "The Claude usage limit has reset. Continue the task you were working on from where you left off." },
        { triggerTurn: true });
    }

    pi.on("message_end", (event: any) => {
      const message = event.message;
      if (message?.role !== "assistant") return;
      const hit = usageLimitOf(message);
      if (hit) { limit = hit; unknownLimit = false; return; }
      if (message.stopReason === "error" && (message.diagnostics ?? []).some((d: any) => d?.type === DIAGNOSTIC)) { unknownLimit = true; return; }
      if (message.stopReason !== "error" && message.provider === (limit?.provider ?? message.provider)) {
        lastSuccessAt = plausible(message.timestamp) ?? clock.now();
        unknownLimit = false;
        if (limit && !limited()) limit = undefined;
      }
    });

    pi.on("agent_settled", (event: any, ctx) => {
      ctxRef = ctx;
      if (event.aborted || !limit || !limited() && clock.now() > resumeAt(limit) + 5 * 60_000) return;
      const branch = ctx.sessionManager.getBranch();
      const last = [...branch].reverse().find((e: any) => e.type === "message") as any;
      const lastMessage = last?.message;
      if (usageLimitOf(lastMessage)?.resetsAt === limit.resetsAt) arm(limit, ctx);
    });

    // Re-arm after /reload or resume if the branch still ends on a limit hit.
    pi.on("session_start", (_event: any, ctx) => {
      ctxRef = ctx;
      const branch = ctx.sessionManager.getBranch();
      const messages = branch.filter((e: any) => e.type === "message").map((e: any) => e.message);
      const last = messages.at(-1);
      const hit = usageLimitOf(last);
      const ok = [...messages].reverse().find((m: any) => m.role === "assistant" && m.stopReason !== "error" && m.provider === hit?.provider);
      lastSuccessAt = plausible(ok?.timestamp) ?? lastSuccessAt;
      if (hit && clock.now() < resumeAt(hit) + 5 * 60_000) { limit = hit; arm(hit, ctx); }
    });

    pi.on("input", () => { if (timer !== undefined) clearWait("you sent a message"); return { action: "continue" }; });
    pi.on("model_select", (_event: any, ctx) => {
      if (timer !== undefined && ctx.model?.provider !== limit?.provider) clearWait("model changed");
    });
    pi.on("session_before_compact", () => (limited() || unknownLimit ? { cancel: true } : undefined));
    pi.on("session_shutdown", () => { clearWait(); ctxRef = undefined; });

    pi.registerCommand("autocontinue", {
      description: "Auto-continue after Claude usage-limit reset: on | always | off | cancel | status",
      handler: async (args: string, ctx) => {
        const arg = args.trim().toLowerCase();
        if (arg === "cancel") { clearWait(timer !== undefined ? "cancelled" : undefined); return; }
        const next = arg === "on" ? "cache" : parseMode(arg);
        if (next) {
          mode = next;
          if (mode === "off") clearWait(timer !== undefined ? "turned off" : undefined);
          else if (limit && limited() && timer === undefined) arm(limit, ctx);
        }
        const waiting = timer !== undefined && limit ? `; waiting until ${clockText(resumeAt(limit))}` : "";
        ctx.ui.notify(`Auto-continue: ${mode === "cache" ? "on (within cache window)" : mode}${waiting}.`, "info");
      },
    });
  };
}

export function parseMode(value: string | undefined): Mode | undefined {
  return value === "cache" || value === "always" || value === "off" ? value : undefined;
}

export default createAutoContinue();
