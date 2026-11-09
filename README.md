# me-like-pi

Extensions and a skill for the [Pi coding agent](https://github.com/earendil-works/pi),
taken from my own setup and cleaned up to share. They're written for Pi 1.5 and Node 22,
mostly used with Claude through the Claude Code adapter, on Windows, macOS and Linux.

Status: things marked **new** or **experimental** work for me but may change. Issues and
PRs are welcome; I sync changes back by hand, so it can take a while.

## What's here

| Extension | What it does | Status |
|---|---|---|
| [`pi-warm-compact`](extensions/pi-warm-compact.ts) | `/warm-compact`: compaction that runs as the session's own next turn, so it reuses the prompt cache. Default mode shrinks old tool output and lets the model condense or fold old text with recallable edits (`context_recall` restores originals). See [docs/WARM_COMPACT.md](docs/WARM_COMPACT.md). | new |
| [`pi-delegate`](extensions/pi-delegate.ts) | `delegate` tool and `/do`: fork the conversation to a worker on the same model that works in the same folder and reports back. `delegate_history` reads what a worker did; workers can be continued. | stable |
| [`pi-read-from-top`](extensions/pi-read-from-top.ts) | Fullscreen mode: a long reply stops scrolling when its first line reaches the top, so you read it from the start. Skips thinking by default. | stable |
| [`pi-includes`](extensions/pi-includes.ts) | `@path.md` lines in the global `AGENTS.md` include other files, with `{os}` and `{host}` placeholders (e.g. `@machines/{os}.md`). `/includes` shows what loaded. | stable |
| [`pi-grab`](extensions/pi-grab.ts) | `/grab`: pick a recent reply, prompt, tool result or `/do` result, or one paragraph or code block of it, and copy it. | stable |
| [`pi-thinking-shortcuts`](extensions/pi-thinking-shortcuts.ts) | Shift+Up / Shift+Down step the thinking level up or down (no wrap-around). | stable |
| [`pi-claude-search`](extensions/pi-claude-search.ts) | `claude_web_search`: web search through the local `claude` CLI (needs Claude Code installed and logged in). | stable |
| [`pi-web-search`](extensions/pi-web-search.ts) | `web_search` with one backend you choose: a self-hosted SearXNG, or Codex search (needs Pi's `openai-codex` login). Configure in `~/.pi/agent/web-search.json`. | stable |
| [`pi-autocontinue`](extensions/pi-autocontinue.ts) | After a Claude plan usage limit resets, sends one "continue" (by default only while the prompt cache is still warm). `/autocontinue on\|always\|off\|cancel\|status`. Needs the usage-limit diagnostic from [kylegrover/pi-claude-code](https://github.com/kylegrover/pi-claude-code). | stable |
| [`pi-cache-observability`](extensions/pi-cache-observability.ts) | Records cache and lifecycle observations as custom session entries (never sent to the model), for later analysis. | stable |
| [`pi-sprint`](extensions/pi-sprint.ts) | `/closeout` and `/pivot` (wrap up, compact, then stop or start a new topic), `/handoff` and `/handback` (hand a bounded task to a cheaper model and return). | experimental |
| [`pi-subq`](extensions/pi-subq.ts) | Registers [SubQ](https://subq.ai)'s fast classifier as a codemode model (`models.classify`). Needs `SUBQ_API_KEY`. | experimental |

| Skill | What it does |
|---|---|
| [`agent-chrome`](skills/agent-chrome/SKILL.md) | Drives a separate Chrome profile over the local DevTools protocol: click, type, fill forms, screenshot, read logged-in or JavaScript-rendered pages. Loopback only, no telemetry. Adapted in part from [browser-use/browser-harness](https://github.com/browser-use/browser-harness) (MIT); see its [NOTICE](skills/agent-chrome/NOTICE). |

## Install

As a Pi package, loading only what you want (recommended):

```json
{
  "packages": [
    {
      "source": "git:github.com/kylegrover/me-like-pi",
      "extensions": [
        "extensions/pi-warm-compact.ts",
        "extensions/pi-delegate.ts",
        "extensions/pi-read-from-top.ts",
        "extensions/pi-grab.ts"
      ],
      "skills": []
    }
  ]
}
```

Put that in `~/.pi/agent/settings.json` (merge with your existing `packages`), then
`/reload`. Leave out the `extensions` or `skills` key to load all of them. Or install
everything with:

```sh
pi install git:github.com/kylegrover/me-like-pi
```

To try one extension without installing: `pi -e ./extensions/pi-grab.ts`.

## Tests

```sh
node scripts/check.mjs          # tests + typecheck against your installed Pi
```

It finds Pi under `~/.pi/agent/install/releases/`, or set `PI_PACKAGE_ROOT` to Pi's
`pi-coding-agent` package folder. Some tests load Pi's own modules and skip without it.
Typechecking needs TypeScript in the npm cache or on `PATH`.

## License

MIT. See [LICENSE](LICENSE).
