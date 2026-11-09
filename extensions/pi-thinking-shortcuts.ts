import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

type Baseline = { provider: string; model: string; level: ReturnType<ExtensionAPI["getThinkingLevel"]> };
const entryType = "pi-thinking-baseline";
const statusKey = "pi-thinking-shortcuts";

function isBaseline(value: unknown): value is Baseline {
  if (!value || typeof value !== "object") return false;
  const b = value as Partial<Baseline>;
  return typeof b.provider === "string" && typeof b.model === "string" &&
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(b.level ?? "");
}

// Session-only directional steps; capabilities come from Pi, not a copied model table.
export default function (pi: ExtensionAPI) {
  let baseline: Baseline | undefined;
  let pendingRequest: Baseline | undefined;

  function render(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const current = pi.getThinkingLevel();
    const used = baseline;
    ctx.ui.setWidget(statusKey, used && ctx.model?.provider === used.provider && ctx.model.id === used.model && current !== used.level
      ? [`Thinking: ${used.level} → ${current}`] : undefined, { placement: "aboveEditor" });
  }

  function restore(ctx: ExtensionContext) {
    // Clear the previous footer-based version's slot when reloading in place.
    if (ctx.hasUI) ctx.ui.setStatus(statusKey, undefined);
    baseline = undefined;
    pendingRequest = undefined;
    // Follow active ancestry, never chronological/off-branch worker history.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === entryType && isBaseline(entry.data)) baseline = entry.data;
    }
    render(ctx);
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("thinking_level_select", (_event, ctx) => render(ctx));
  pi.on("model_select", (_event, ctx) => render(ctx));
  pi.on("turn_start", (_event, ctx) => {
    // Capture at turn dispatch, not after a mid-request keypress changes selection.
    pendingRequest = ctx.model ? { provider: ctx.model.provider, model: ctx.model.id, level: pi.getThinkingLevel() } : undefined;
  });
  pi.on("before_provider_request", (_event, ctx) => {
    // Ignore compaction/other side requests with no normal agent turn snapshot.
    if (!pendingRequest) return;
    const request = pendingRequest;
    pendingRequest = undefined;
    if (!baseline || baseline.provider !== request.provider || baseline.model !== request.model || baseline.level !== request.level) {
      // One tiny non-message marker per baseline change; no prompts, payloads or usage.
      pi.appendEntry(entryType, request);
    }
    baseline = request;
    render(ctx);
  });
  pi.on("agent_settled", () => { pendingRequest = undefined; });
  pi.on("session_shutdown", (_event, ctx) => {
    baseline = undefined;
    pendingRequest = undefined;
    if (ctx.hasUI) ctx.ui.setWidget(statusKey, undefined);
  });

  function step(ctx: ExtensionContext, direction: 1 | -1) {
    if (!ctx.hasUI) return;
    if (!ctx.model) {
      ctx.ui.notify("No active model; thinking unchanged.", "warning");
      return;
    }
    const levels = getSupportedThinkingLevels(ctx.model);
    if (levels.length < 2) return;
    const current = pi.getThinkingLevel();
    const index = levels.indexOf(current);
    if (index < 0) {
      ctx.ui.notify("Current thinking level is not in the model's supported list; use /thinking.", "warning");
      return;
    }
    const target = levels[index + direction];
    if (target === undefined) return; // Silent no-op at either bound.
    pi.setThinkingLevel(target);
    const effective = pi.getThinkingLevel();
    if (effective !== target) {
      ctx.ui.notify(`Requested thinking ${target}; Pi reports ${effective}. Check /thinking.`, "warning");
      return;
    }
    render(ctx);
  }

  pi.registerShortcut("shift+up", {
    description: "Increase thinking level (no wrap)",
    handler: async ctx => step(ctx, 1),
  });
  pi.registerShortcut("shift+down", {
    description: "Decrease thinking level (no wrap)",
    handler: async ctx => step(ctx, -1),
  });
}
