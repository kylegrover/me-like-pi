import { readFileSync } from "node:fs";
import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

// /grab: copy more than the last reply. Built-in /copy (Ctrl+X) stays the simple default.
//   /grab          browse recent items (newest at the bottom). Up/down picks an item, Enter
//                  copies it whole; Right opens its parts (paragraphs, code blocks, quotes,
//                  lists, tables), Enter copies one part, Left goes back, Esc cancels.
//   /grab do       last /do result, full report from the worker session when truncated
//   /grab tool     last tool result
//   /grab user     last prompt
//   /grab N        last N assistant replies, oldest first

export type Item = { kind: "assistant" | "user" | "do" | "tool"; label: string; text: string };

const TRUNCATED = "[Report truncated; full text is in the worker session.]";
const PICKER_LIMIT = 30;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n");
}

/** Final assistant text of a saved worker session, or undefined if unreadable. */
export function workerReport(file: string): string | undefined {
  try {
    const lines = readFileSync(file, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]);
      if (entry?.type === "message" && entry.message?.role === "assistant") {
        const text = textOf(entry.message.content).trim();
        if (text) return text;
      }
    }
  } catch {}
  return undefined;
}

function doText(entry: any): string {
  const raw = textOf(entry.content);
  const file = entry.details?.sessionFile;
  if (!raw.includes(TRUNCATED) || typeof file !== "string") return raw;
  const full = workerReport(file);
  if (!full) return raw;
  const header = raw.match(/^\[\/do worker (?:result|incomplete)\] Task: .*\n\n/)?.[0] ?? "";
  return `${header}${full}\n\nWorker session: ${file}`;
}

/** Copyable items on the current branch, oldest first. */
export function collect(branch: any[]): Item[] {
  const items: Item[] = [];
  for (const entry of branch) {
    if (entry?.type === "message") {
      const m = entry.message;
      const text = textOf(m?.content).trim();
      if (!text) continue;
      if (m.role === "assistant") items.push({ kind: "assistant", label: "reply", text });
      else if (m.role === "user") items.push({ kind: "user", label: "prompt", text });
      else if (m.role === "toolResult") items.push({ kind: "tool", label: `tool ${m.toolName ?? ""}`.trim(), text });
    } else if (entry?.type === "custom_message" && entry.customType === "delegate-result") {
      items.push({ kind: "do", label: "/do", text: doText(entry).trim() });
    }
  }
  return items;
}

export type Part = { kind: "paragraph" | "code" | "quote" | "list" | "table" | "heading"; label: string; text: string };

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const LIST = /^\s*(?:[-*+]|\d+[.)])\s+/;

function blockKind(line: string): Part["kind"] {
  if (/^\s*>/.test(line)) return "quote";
  if (LIST.test(line)) return "list";
  if (/^\s*\|/.test(line)) return "table";
  if (/^\s*#{1,6}\s/.test(line)) return "heading";
  return "paragraph";
}

/**
 * Split Markdown text into copyable parts. Code blocks copy their contents without
 * fences; quotes copy without the leading `>` markers; other blocks copy as written.
 */
export function splitParts(text: string): Part[] {
  const parts: Part[] = [];
  const lines = text.split("\n");
  let block: string[] = [];
  let kind: Part["kind"] = "paragraph";
  const flush = () => {
    while (block.length && !block.at(-1)!.trim()) block.pop();
    if (block.length) {
      const body = kind === "quote" ? block.map(l => l.replace(/^\s*> ?/, "")).join("\n") : block.join("\n");
      parts.push({ kind, label: kind, text: body });
    }
    block = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const marker = fence[1]!;
      const lang = fence[2]!.trim().split(/\s+/)[0] ?? "";
      const code: string[] = [];
      let j = i + 1;
      const closes = (l: string) => {
        const t = l.trim();
        return t.length >= marker.length && t === marker[0]!.repeat(t.length);
      };
      while (j < lines.length && !closes(lines[j]!)) code.push(lines[j++]!);
      parts.push({ kind: "code", label: lang ? `code ${lang}` : "code", text: code.join("\n") });
      i = j;
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const next = blockKind(line);
    // A heading always stands alone; list/quote/table lines continue their block,
    // and indented or plain lines continue a list item.
    const continues = block.length && next !== "heading" && kind !== "heading" &&
      (next === kind || (kind === "list" && next === "paragraph" && /^\s+/.test(line)));
    if (!continues) { flush(); kind = next; }
    block.push(line);
  }
  flush();
  return parts;
}

export type NavKey = "up" | "down" | "left" | "right" | "enter" | "escape";

/** Keyboard state for the two-level picker; pure so it can be tested without a terminal. */
export function createNavigator(items: Item[]) {
  const state = { level: 0 as 0 | 1, item: Math.max(0, items.length - 1), part: 0, parts: [] as Part[] };
  return {
    state,
    current: () => (state.level === 0 ? items[state.item] : state.parts[state.part]),
    /** Returns the text and description to copy, null to cancel, or undefined to keep going. */
    press(key: NavKey): { text: string; what: string } | null | undefined {
      const list = state.level === 0 ? items.length : state.parts.length;
      if (key === "escape") return null;
      if (key === "up") {
        if (state.level === 0) state.item = Math.max(0, state.item - 1);
        else state.part = Math.max(0, state.part - 1);
      } else if (key === "down") {
        if (state.level === 0) state.item = Math.min(list - 1, state.item + 1);
        else state.part = Math.min(list - 1, state.part + 1);
      } else if (key === "right" && state.level === 0 && items[state.item]) {
        const parts = splitParts(items[state.item]!.text);
        if (parts.length > 1) Object.assign(state, { level: 1, parts, part: 0 });
      } else if (key === "left" && state.level === 1) {
        state.level = 0;
      } else if (key === "enter") {
        const item = items[state.item];
        if (!item) return null;
        if (state.level === 0) return { text: item.text, what: item.label };
        const part = state.parts[state.part];
        return part ? { text: part.text, what: `${part.label} from ${item.label}` } : null;
      }
      return undefined;
    },
  };
}

const oneLine = (s: string, n = 70) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/** Text to copy for an argument, or an error string. Picker (no argument) is handled by the caller. */
export function resolve(items: Item[], arg: string): { text: string; what: string } | { error: string } {
  const last = (kind: Item["kind"]) => [...items].reverse().find(i => i.kind === kind);
  const pick = (kind: Item["kind"], what: string) => {
    const item = last(kind);
    return item ? { text: item.text, what } : { error: `No ${what} on this branch.` };
  };
  if (arg === "do") return pick("do", "/do result");
  if (arg === "tool") return pick("tool", "tool result");
  if (arg === "user") return pick("user", "prompt");
  if (/^\d+$/.test(arg)) {
    const n = Number(arg);
    if (n < 1) return { error: "Usage: /grab N with N ≥ 1" };
    const replies = items.filter(i => i.kind === "assistant").slice(-n);
    if (!replies.length) return { error: "No assistant replies on this branch." };
    return { text: replies.map(r => r.text).join("\n\n---\n\n"), what: `${replies.length} repl${replies.length === 1 ? "y" : "ies"}` };
  }
  return { error: "Usage: /grab [do|tool|user|N]" };
}

const LIST_ROWS = 12;
const PREVIEW_ROWS = 6;

/** Two-level picker: items, then the parts of one item. */
function browse(ctx: ExtensionContext, items: Item[]) {
  return ctx.ui.custom<{ text: string; what: string } | null>((tui, theme, keybindings, done) => {
    const nav = createNavigator(items);
    const keyOf = (data: string): NavKey | undefined => {
      if (keybindings.matches(data, "tui.select.up")) return "up";
      if (keybindings.matches(data, "tui.select.down")) return "down";
      if (keybindings.matches(data, "tui.select.confirm")) return "enter";
      if (keybindings.matches(data, "tui.select.cancel")) return "escape";
      if (matchesKey(data, Key.right)) return "right";
      if (matchesKey(data, Key.left)) return "left";
      return undefined;
    };
    let cache: { width: number; lines: string[] } | undefined;
    const partCounts = items.map(item => splitParts(item.text).length);
    const listHeight = Math.min(LIST_ROWS, Math.max(items.length, ...partCounts));
    const row = (selected: boolean, label: string, text: string, width: number, extra = "") => {
      const body = `${selected ? "> " : "  "}${label.padEnd(10)} ${oneLine(text, Math.max(10, width))}${extra}`;
      return truncateToWidth(selected ? theme.fg("accent", body) : body, width);
    };
    return {
      render(width: number): string[] {
        if (cache?.width === width) return cache.lines;
        const { level, item, part, parts } = nav.state;
        const entries = level === 0 ? items : parts;
        const selected = level === 0 ? item : part;
        const start = Math.max(0, Math.min(selected - Math.floor(LIST_ROWS / 2), entries.length - LIST_ROWS));
        const title = level === 0
          ? "Copy which item? (newest at bottom)"
          : `Parts of ${items[item]!.label}: ${oneLine(items[item]!.text, 50)}`;
        const lines = [theme.fg("accent", theme.bold(title))];
        // Fixed-height layout so nothing jumps while moving: preview first (always
        // PREVIEW_ROWS + 1 lines), then a list padded to the same height at both levels.
        const preview = (nav.current()?.text ?? "").split("\n");
        const more = preview.length > PREVIEW_ROWS ? `… ${preview.length - PREVIEW_ROWS} more lines` : "";
        for (let i = 0; i < PREVIEW_ROWS; i++) lines.push(theme.fg("dim", preview[i] ?? ""));
        lines.push(theme.fg("dim", more));
        lines.push(theme.fg("dim", "─".repeat(Math.max(0, Math.min(width, 60)))));
        lines.push(start > 0 ? theme.fg("dim", `  … ${start} more above`) : "");
        const shown = entries.slice(start, start + LIST_ROWS);
        shown.forEach((entry, offset) => {
          const index = start + offset;
          const count = level === 0 ? partCounts[index]! : 0;
          lines.push(row(index === selected, entry.label, entry.text, width - 20, count > 1 ? theme.fg("dim", ` [${count}]`) : ""));
        });
        for (let i = shown.length; i < listHeight; i++) lines.push("");
        const below = entries.length - start - LIST_ROWS;
        lines.push(below > 0 ? theme.fg("dim", `  … ${below} more below`) : "");
        lines.push(theme.fg("dim", level === 0
          ? "↑↓ move · Enter copy item · → parts · Esc cancel"
          : "↑↓ move · Enter copy part · ← back · Esc cancel"));
        cache = { width, lines: lines.map(line => truncateToWidth(line, width)) };
        return cache.lines;
      },
      handleInput(data: string): void {
        const key = keyOf(data);
        if (!key) return;
        const result = nav.press(key);
        if (result !== undefined) return done(result);
        cache = undefined;
        tui.requestRender();
      },
      invalidate() { cache = undefined; },
    };
  }, { blocked: { kind: "question", message: "Pick something to copy" } });
}

export default function (pi: ExtensionAPI) {
  async function copy(ctx: ExtensionContext, text: string, what: string) {
    await copyToClipboard(text);
    if (ctx.hasUI) ctx.ui.notify(`Copied ${what} (${text.length.toLocaleString()} chars)`, "info");
  }

  pi.registerCommand("grab", {
    description: "Copy a recent reply, prompt, /do result or tool result (/grab [do|tool|user|N])",
    getArgumentCompletions: (prefix: string) =>
      ["do", "tool", "user", "3"].filter(v => v.startsWith(prefix)).map(v => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      const items = collect(ctx.sessionManager.getBranch());
      const arg = (args ?? "").trim().toLowerCase();
      try {
        if (arg) {
          const r = resolve(items, arg);
          if ("error" in r) return void (ctx.hasUI && ctx.ui.notify(r.error, "warning"));
          return await copy(ctx, r.text, r.what);
        }
        if (!ctx.hasUI) return;
        if (!items.length) return void ctx.ui.notify("Nothing to copy on this branch.", "warning");
        if (ctx.mode === "tui") {
          const picked = await browse(ctx, items.slice(-PICKER_LIMIT));
          if (picked) await copy(ctx, picked.text, picked.what);
          return;
        }
        const recent = items.slice(-PICKER_LIMIT).reverse();
        const labels = recent.map((item, i) => `${String(i + 1).padStart(2)}. ${item.label.padEnd(10)} ${oneLine(item.text)}`);
        const choice = await ctx.ui.select("Copy which item? (newest first)", labels);
        if (choice === undefined) return;
        const item = recent[labels.indexOf(choice)];
        if (item) await copy(ctx, item.text, item.label);
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
