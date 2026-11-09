// Fullscreen mode: a reply taller than the window stops scrolling when its first line
// reaches the top row, so you read it from the start. Scroll to the end (wheel, PageDown
// or ctrl+end) to follow output again. Regular (non-fullscreen) mode is left alone.
//
// Thinking is skipped by default: the pin lands on the reply's first answer line, not on its
// thinking (expanded, or the collapsed "Thinking..." label), and while only thinking has
// streamed the view keeps following. Turn that off with PI_READ_FROM_TOP_THINKING=include, or
// for this session with `/read-from-top thinking include` (`skip` turns it back on).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findTranscript, ReadFromTop } from "./lib/read-from-top.ts";

const probeKey = "pi-read-from-top";

export default function readFromTop(pi: ExtensionAPI) {
  let state: ReadFromTop | undefined;
  let skipThinking = process.env.PI_READ_FROM_TOP_THINKING !== "include";

  const attach = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || ctx.mode !== "tui" || state) return;
    // setWidget hands its factory the live TUI; take the transcript and remove the probe.
    let tui: unknown;
    ctx.ui.setWidget(probeKey, (t) => { tui = t; return { render: () => [], invalidate() {} }; }, { placement: "belowEditor" });
    ctx.ui.setWidget(probeKey, undefined);
    const view = findTranscript(tui);
    if (view) state = new ReadFromTop(view, { skipThinking });
  };

  pi.registerCommand("read-from-top", {
    description: "read-from-top settings: `thinking skip` (default) or `thinking include`",
    handler: async (args, ctx) => {
      const [key, value] = args.trim().split(/\s+/);
      if (key === "thinking" && (value === "skip" || value === "include")) {
        skipThinking = value === "skip";
        state?.dispose(); state = undefined; attach(ctx);
        ctx.ui.notify(`read-from-top: thinking ${value} (this session)`, "info");
      } else {
        ctx.ui.notify(`read-from-top: thinking is ${skipThinking ? "skipped" : "included"}. Usage: /read-from-top thinking skip|include`, "info");
      }
    },
  });

  pi.on("session_start", (_e, ctx) => attach(ctx));
  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    attach(ctx);
    state?.start();
  });
  pi.on("message_end", (event) => { if (event.message.role === "assistant") state?.end(); });
  pi.on("session_shutdown", () => { state?.dispose(); state = undefined; });
}
