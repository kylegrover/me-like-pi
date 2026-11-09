import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Passive, append-only cache/lifecycle observations for Pi sessions.
 *
 * This extension deliberately does not alter prompts, provider requests, model
 * selection, compaction summaries, or cache lifetime. Custom entries are not
 * included in the LLM context. Other tools (session indexers, dashboards) can read them
 * from the session file.
 */

export const CACHE_ENTRY_TYPE = "pi-cache-observability";
export const CACHE_SCHEMA_VERSION = 1;

type Evidence = "confirmed" | "observed" | "modeled" | "unknown";

type CacheEvent = {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  kind: "observation" | "policy" | "invalidation" | "compaction";
  source:
    | "pi-assistant-usage"
    | "pi-model-select"
    | "pi-thinking-select"
    | "pi-compaction";
  provider?: string;
  model?: string;
  evidence: Evidence;
  data: Record<string, unknown>;
};

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function appendSafely(pi: ExtensionAPI, ctx: { sessionManager: { getSessionFile(): string | undefined } }, event: CacheEvent): void {
  // In-memory sessions have no file; Pi 1.4 no longer exposes isPersisted() to extensions.
  if (!ctx.sessionManager.getSessionFile()) return;
  try {
    pi.appendEntry(CACHE_ENTRY_TYPE, event);
  } catch {
    // Observability must never fail or interrupt the user's agent turn.
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || !event.message.usage) return;

    const usage = event.message.usage;
    const cacheReadTokens = numberOrZero(usage.cacheRead);
    const cacheWriteTokens = numberOrZero(usage.cacheWrite);
    const observation: CacheEvent = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      kind: "observation",
      source: "pi-assistant-usage",
      provider: event.message.provider,
      model: event.message.model,
      evidence: cacheReadTokens > 0 ? "observed" : "unknown",
      data: {
        inputTokens: numberOrZero(usage.input),
        outputTokens: numberOrZero(usage.output),
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens: numberOrZero(usage.reasoning),
        totalTokens: numberOrZero(usage.totalTokens),
        cacheReuse: cacheReadTokens > 0,
      },
    };
    appendSafely(pi, ctx, observation);
  });

  pi.on("model_select", (event, ctx) => {
    const previous = event.previousModel;
    if (!previous) return;
    if (previous.provider === event.model.provider && previous.id === event.model.id) return;

    appendSafely(pi, ctx, {
      schemaVersion: CACHE_SCHEMA_VERSION,
      kind: "invalidation",
      source: "pi-model-select",
      provider: event.model.provider,
      model: event.model.id,
      evidence: "confirmed",
      data: {
        reason: "model-change",
        previousProvider: previous.provider,
        previousModel: previous.id,
      },
    });
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (event.level === event.previousLevel) return;

    appendSafely(pi, ctx, {
      schemaVersion: CACHE_SCHEMA_VERSION,
      kind: "invalidation",
      source: "pi-thinking-select",
      evidence: "confirmed",
      data: {
        reason: "thinking-level-change",
        previousLevel: event.previousLevel,
        level: event.level,
      },
    });
  });

  pi.on("session_compact", (event, ctx) => {
    appendSafely(pi, ctx, {
      schemaVersion: CACHE_SCHEMA_VERSION,
      kind: "compaction",
      source: "pi-compaction",
      evidence: "confirmed",
      data: {
        reason: event.reason,
        fromExtension: event.fromExtension,
        tokensBefore: numberOrZero(event.compactionEntry.tokensBefore),
        invalidatesPriorObservations: true,
      },
    });
  });
}
