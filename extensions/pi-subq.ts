import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

/** Opt-in native classifier; no routing, chat-model changes or startup requests. */
export default function (pi: ExtensionAPI) {
  // This public entry point works with Pi 1.3.0's extension-loader aliases.
  const classify = builtinProviders().find(provider => provider.id === "typesafe")?.classify;
  if (!classify) throw new Error("SubQ requires Pi's native System One classifier support");
  pi.registerProvider("subq", {
    name: "SubQ",
    apiKey: "$SUBQ_API_KEY",
    baseUrl: "https://api.subq.ai/v1",
    models: [
      {
        type: "classifier",
        id: "subq-snap-1.1",
        name: "SubQ Snap 1.1",
        api: "typesafe-system-one",
        // Pi 1.3.0's System One adapter rejects images. Do not advertise them.
        input: ["text"],
        contextWindow: 393216,
        // https://docs.subq.ai/using-the-api/models/ — reviewed 2026-10-24.
        cost: { input: 0.04, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    classifiers: { "typesafe-system-one": { classify } },
  });
}
