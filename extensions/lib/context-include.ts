// `@path.md` includes for the global AGENTS.md, with {os} and {host} placeholders.
// Pure helpers; the extension entry is extensions/pi-includes.ts.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const MAX_DEPTH = 5;
export const MAX_BYTES = 64 * 1024;

export type Vars = { os: string; host: string };
export type Included = { path: string; content: string };
export type Expansion = { included: Included[]; missing: string[]; skipped: string[] };

/** windows | mac | linux (anything else passes through), and the short lowercase hostname. */
export function currentVars(platform: string = process.platform, hostname = ""): Vars {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "mac" : platform;
  return { os, host: hostname.split(".")[0]!.toLowerCase() };
}

/** `@path.md` alone on a line (an optional list marker is allowed), outside code fences. */
export function references(content: string): string[] {
  const refs: string[] = [];
  let fenced = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```")) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = /^(?:[-*+]\s+|\d+\.\s+)?@(\S+\.md)$/.exec(line);
    if (m && !refs.includes(m[1]!)) refs.push(m[1]!);
  }
  return refs;
}

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

export function resolveRef(ref: string, baseDir: string, vars: Vars): string {
  const filled = ref.replaceAll("{os}", vars.os).replaceAll("{host}", vars.host);
  const expanded = filled === "~" || filled.startsWith("~/") ? join(homedir(), filled.slice(1)) : filled;
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

/**
 * Expand includes reachable from the given context files, depth-first, each file once.
 * Relative paths resolve from the real (symlink-resolved) folder of the including file,
 * so a linked ~/.pi/agent/AGENTS.md includes from the repo.
 */
export function expandIncludes(files: { path: string; content: string }[], vars: Vars): Expansion {
  const out: Expansion = { included: [], missing: [], skipped: [] };
  const seen = new Set(files.map(f => real(f.path)));
  let bytes = 0;
  const walk = (file: string, content: string, depth: number) => {
    for (const ref of references(content)) {
      const target = resolveRef(ref, dirname(real(file)), vars);
      const key = real(target);
      if (seen.has(key)) continue;
      seen.add(key);
      if (depth >= MAX_DEPTH) { out.skipped.push(`${target} (deeper than ${MAX_DEPTH})`); continue; }
      let text: string;
      try {
        if (!statSync(key).isFile()) throw new Error("not a file");
        text = readFileSync(key, "utf8");
      } catch { out.missing.push(target); continue; }
      const size = Buffer.byteLength(text);
      if (bytes + size > MAX_BYTES) { out.skipped.push(`${target} (over ${MAX_BYTES} bytes in total)`); continue; }
      bytes += size;
      out.included.push({ path: target, content: text.trim() });
      walk(key, text, depth + 1);
    }
  };
  for (const f of files) walk(f.path, f.content, 0);
  return out;
}

/** Only the global context file in the agent dir expands includes, never project files. */
export function isAgentDirFile(path: string, agentDir: string): boolean {
  return resolve(dirname(path)).toLowerCase() === resolve(agentDir).toLowerCase();
}

/**
 * Indexes of context files that are the same file (by real path) as an earlier one, e.g.
 * the repo's own AGENTS.md when ~/.pi/agent/AGENTS.md links to it. Keep the first copy.
 */
export function duplicateIndexes(files: { path: string }[]): number[] {
  const seen = new Set<string>();
  const dupes: number[] = [];
  files.forEach((f, i) => {
    const key = process.platform === "win32" ? real(f.path).toLowerCase() : real(f.path);
    if (seen.has(key)) dupes.push(i); else seen.add(key);
  });
  return dupes;
}

export function renderSection(included: Included[]): string {
  return included.map(f => `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`).join("\n\n");
}
