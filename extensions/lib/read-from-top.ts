// Stop following a streaming reply once its first line reaches the top of the transcript.
// Works on Pi's fullscreen transcript ScrollView (pi-tui), duck-typed because the bundled
// CLI has its own copy of the class. Scrolling back to the end resumes normal following.
//
// Where the reply starts: Pi adds messages to the chat container and renders on the next
// tick, so a height read at message_start is stale (it misses the user's message). Instead,
// remember how many chat children existed when the reply started, and after each layout
// sum the rendered heights of everything before them (Container.render records them).

export type ScrollLike = {
  readonly primary: boolean;
  readonly scrollTop: number;
  readonly isFollowingEnd: boolean;
  scrollTo(top: number, options?: { disableFollow?: boolean }): void;
  updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void;
};

type ContainerLike = { children: unknown[]; mouseLayout?: { children: { component: unknown; height: number }[] } };

const HOOK = Symbol.for("pi-read-from-top.hook");
const PATCHED = Symbol.for("pi-read-from-top.patched");
type Hooked = ScrollLike & { [HOOK]?: () => void; [PATCHED]?: boolean; child?: unknown };

const isScroll = (v: any): v is ScrollLike =>
  !!v && typeof v.scrollTo === "function" && typeof v.updateLayout === "function" && "isFollowingEnd" in v;
const isContainer = (v: any): v is ContainerLike => !!v && Array.isArray(v.children);

/** The primary transcript ScrollView under a fullscreen TUI's layout root, if any. */
export function findTranscript(tui: any): ScrollLike | undefined {
  const seen = new Set<unknown>();
  const visit = (node: any, depth: number): ScrollLike | undefined => {
    if (!node || typeof node !== "object" || seen.has(node) || depth > 6) return undefined;
    seen.add(node);
    if (isScroll(node) && node.primary) return node;
    const kids = [...(node.entries ?? []).map((e: any) => e?.component), ...(Array.isArray(node.children) ? node.children : [])];
    for (const k of kids) { const found = visit(k, depth + 1); if (found) return found; }
    return undefined;
  };
  return visit(tui?.layoutRoot, 0);
}

/** The transcript document and its chat container (Pi: header, resources, chat; chat is last). */
function containers(view: ScrollLike): { doc: ContainerLike; chat: ContainerLike } | undefined {
  const doc = (view as Hooked).child;
  if (!isContainer(doc)) return undefined;
  const chat = doc.children.at(-1);
  return isContainer(chat) ? { doc, chat } : undefined;
}

/** Rendered line offset of chat child `index`, from the last render; undefined if not rendered yet. */
export function lineOffset(doc: ContainerLike, chat: ContainerLike, index: number): number | undefined {
  const docRows = doc.mouseLayout?.children, chatRows = chat.mouseLayout?.children;
  if (!docRows || !chatRows || chatRows.length <= index || chatRows.length !== chat.children.length) return undefined;
  let top = 0;
  for (const row of docRows) { if (row.component === chat) break; top += row.height; }
  for (let i = 0; i < index; i++) top += chatRows[i]!.height;
  return top;
}

/** A pi-tui Spacer: blank rows and nothing else. */
const isSpacer = (c: any) => !!c && typeof c.lines === "number" && typeof c.setLines === "function";
/**
 * Pi wraps each thinking run (expanded, or the collapsed "Thinking..." label) in a MouseRegion so
 * a click toggles it; text blocks are bare Markdown. The wrapped child is the thinking component.
 */
const isThinking = (c: any) => !!c && "child" in c && typeof c.onMouse === "function" && typeof c.handleMouse === "function";

/**
 * Rows to skip at the top of a reply so its first answer line, not its thinking, lands on the top
 * row. Pi's AssistantMessageComponent is [contentContainer], whose children are spacers, thinking
 * runs (MouseRegion) and text (Markdown) in order. Returns undefined while the reply so far is only
 * spacers and thinking (nothing to pin yet), or when the shape isn't recognized (0: no skip).
 */
export function leadingThinkingRows(reply: unknown): number | undefined {
  const outer = isContainer(reply) ? reply : undefined;
  const content = outer?.children.length === 1 && isContainer(outer.children[0]) ? outer.children[0] : undefined;
  const rows = content?.mouseLayout?.children;
  if (!content || !rows || rows.length !== content.children.length) return 0;
  let skip = 0;
  for (const row of rows) {
    if (isSpacer(row.component) || isThinking(row.component)) { skip += row.height; continue; }
    return skip; // first answer block
  }
  return undefined; // only thinking so far
}

export type Options = { skipThinking?: boolean };

export class ReadFromTop {
  private startIndex: number | undefined;
  private readonly view: ScrollLike;
  private readonly skipThinking: boolean;
  constructor(view: ScrollLike, options: Options = {}) {
    this.view = view;
    this.skipThinking = options.skipThinking ?? true;
    const v = view as Hooked;
    // Patch once per ScrollView instance; a /reload swaps in the new handler.
    if (!v[PATCHED]) {
      const original = v.updateLayout.bind(v);
      v.updateLayout = (c, h, r) => { original(c, h, r); (v as Hooked)[HOOK]?.(); };
      v[PATCHED] = true;
    }
    v[HOOK] = () => this.check();
  }

  /** Reply starts (before Pi adds its component): note where it will go, if following the end. */
  start() {
    const parts = containers(this.view);
    this.startIndex = this.view.isFollowingEnd && parts ? parts.chat.children.length : undefined;
  }

  end() { this.startIndex = undefined; }

  dispose() {
    const v = this.view as Hooked;
    if (v[HOOK]) v[HOOK] = undefined;
    this.startIndex = undefined;
  }

  private check() {
    if (this.startIndex === undefined) return;
    // The user scrolled away mid-reply: their choice wins for the rest of this reply.
    if (!this.view.isFollowingEnd) { this.startIndex = undefined; return; }
    const parts = containers(this.view);
    if (!parts) { this.startIndex = undefined; return; }
    let top = lineOffset(parts.doc, parts.chat, this.startIndex);
    if (top === undefined) return;
    if (this.skipThinking) {
      const skip = leadingThinkingRows(parts.chat.children[this.startIndex]);
      if (skip === undefined) return; // only thinking so far: keep following
      top += skip;
    }
    if (this.view.scrollTop <= top) return;
    this.startIndex = undefined; // once per reply, so scrolling back to the end follows again
    this.view.scrollTo(top, { disableFollow: true });
  }
}
