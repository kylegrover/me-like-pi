# `/warm-compact`: compaction that reuses the prompt cache

> New (November 2026). It works in daily use, but its prompts and defaults may still change.
> Built and measured with Claude Opus through the Claude Code adapter; other providers with a
> prompt cache should behave the same way, but haven't been measured.

## The problem with `/compact`

Pi's built-in `/compact` sends a **separate request** with its own system prompt, no tools,
and the old conversation serialized to text, with every tool result cut to 2,000 characters.
None of that matches what the provider has cached, so the whole old context is paid for at
full input price. In 42 of 42 Opus compactions we looked at, the summary call read nothing
from the cache, and a typical one cost about $1.5–1.8.

## What `/warm-compact` does instead

It runs compaction as **the session's own next turn**. The request is the cached
conversation plus one hidden instruction, so the provider reads almost everything from the
cache. The model also sees full tool results, not 2,000-character cuts.

Two modes:

- **`/warm-compact [focus]` (edit mode, the default).** Nothing is summarized away:
  1. **Rules, no model:** old tool results over 400 characters become their first 300
     characters plus a `context_recall("<id>")` note; long tool-call arguments shrink the same
     way; thinking is dropped from old replies.
  2. **A plan from the model:** in the cache-warm turn the model sees a map of the old
     user and assistant messages and returns a small JSON plan to *condense* a reply,
     *fold* a finished stretch into one note, or *replace* text inside a message.
  - Everything is applied as Pi `context_edit` entries. The session file keeps every
    original, and the `context_recall` tool returns any of them, so the model can look up
    exact output it compacted away.
  - Your own messages are never removed. The last ~20k tokens stay verbatim.
  - A second pass later leaves the first pass's edits alone and works on the newer text.
- **`/warm-compact summary [focus]`.** The model writes a structured checkpoint (goal,
  constraints, progress, decisions, next steps, critical context) and Pi's normal
  compaction entry replaces the old turns with it. The last ~20k tokens stay verbatim. Use
  it as the fallback if edit mode is refused (below).

During the compaction turn tool calls are blocked (the tools stay declared so the cached
prefix still matches). Afterwards the instruction and the model's reply are hidden from the
conversation, and a status line reports the sizes, the time and whether the cache was hit.
Automatic compaction is untouched; this only runs when you ask.

## Measurements

One 269k-token session, the same point compacted four ways (Opus):

| | Pi `/compact` | `/warm-compact summary` | `/warm-compact` (edit) |
|---|---|---|---|
| Cache read on the compaction request | 0 | 268,649 | 266,475 |
| Cost of the compaction request | ~$1.81 | ~$0.18 | ~$0.17 |
| Time | ~2 min 20 s | 56 s | 26–38 s |
| Facts kept, of 18 checked | 15 | 13 | 18 |
| Size afterwards (estimate) | ~24k | ~19k | ~35k |

- "Facts kept" is a text-presence check of 18 specific facts from that session (counts,
  IDs, commands, causes found) in the compacted context. One session, one point; treat it
  as a sign, not a benchmark. The summary prompt has since been changed to keep the kinds
  of facts it lost.
- Other real runs: 452k → ~58k in 55 s, 312k → ~87k in 38 s, 470k → 97k in 57 s, all
  reading the cache.

**The cost that remains is the turn after.** Edit mode changes old messages, so the first
request after it can only reuse the cache up to the first changed entry, which in practice
means system prompt plus tools: it rewrites the compacted context once (e.g. 107k written,
~$0.87 on Opus), then later turns read the cache again. Pi's `/compact` pays a rewrite too,
smaller because its summary is smaller. Summed over a compaction and the turn after,
`/warm-compact` came out at roughly a quarter to three quarters of `/compact`'s cost in our
runs (the bigger the kept context, the closer to `/compact`), faster, and with more detail
kept.

## Things to know

- **Run it right after a turn.** The cache only lasts a while (one hour with the Claude Code
  adapter, five minutes on some providers). If the session has been idle longer, it still
  works but reads nothing from the cache; the status line says so.
- **One run per compaction point.** Re-running edit mode several times on the same
  context once triggered a provider refusal (`reasoning_extraction`, Anthropic's
  classifier against output-extraction). The session was left unchanged. If it happens,
  use `/warm-compact summary` for that point, and don't retry the same point.
- **After `/reload`,** extensions or instructions that only *add* something keep the cache.
  With the Claude Code adapter, a changed tool definition used to force a full rewrite;
  [kylegrover/pi-claude-code](https://github.com/kylegrover/pi-claude-code) fixes that.
- **Size estimates** in the status line come from character counts scaled by the last
  reply's real token usage. They can be off by ~20k; the next turn's usage is the real
  number.

## Ideas not built yet

- An extra cache breakpoint at the previous compaction boundary, so the turn after a second
  pass reads up to it instead of rewriting everything.
- A rules-only mode (no model call at all).
- Occasionally summarizing the oldest already-compacted stretch, if repeated passes grow.
