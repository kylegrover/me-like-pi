import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isOpenAI(model: Model<any>): boolean {
  return model.provider === "openai" || model.provider === "openai-codex";
}

/** Default to the active setting. Only OpenAI workers may request another effort. */
export function workerThinking(model: Model<any>, current: ThinkingLevel, requested?: ThinkingLevel): ThinkingLevel {
  if (requested !== undefined && !thinkingLevels.includes(requested)) throw new Error("Invalid worker thinking level.");
  if (requested !== undefined && requested !== current && !isOpenAI(model)) {
    throw new Error("Keep this provider's current thinking level; only OpenAI workers allow an override.");
  }
  return requested ?? current;
}
