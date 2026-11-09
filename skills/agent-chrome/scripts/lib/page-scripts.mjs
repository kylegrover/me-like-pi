// JavaScript evaluated inside the page. Kept as source strings so the CLI never serializes closures.

// Interactive elements -> compact refs. Refs live in a page-global array (no DOM mutation)
// and die with the document, so a stale ref after navigation fails loudly instead of misclicking.
export const SNAPSHOT_FN = String.raw`(max) => {
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],' +
    '[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],' +
    '[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const found = [];
  const visit = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.matches(SEL)) found.push(el);
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(document);
  const clip = (s, n = 80) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const nameOf = (el) => {
    const by = el.getAttribute('aria-labelledby');
    const labelled = by && by.split(/\s+/).map((id) => document.getElementById(id)?.innerText).filter(Boolean).join(' ');
    return clip(el.getAttribute('aria-label') || labelled || el.labels?.[0]?.innerText || el.getAttribute('placeholder') ||
      (['submit', 'button', 'reset'].includes(el.type) ? el.value : '') || el.innerText || el.getAttribute('title') ||
      el.getAttribute('alt') || el.querySelector?.('img[alt]')?.getAttribute('alt') || el.getAttribute('name') || '');
  };
  const visible = (el, r) => r.width > 0 && r.height > 0 &&
    (typeof el.checkVisibility !== 'function' || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  const rows = [];
  for (const el of found) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const inView = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    rows.push({ el, r, inView });
  }
  rows.sort((a, b) => (b.inView - a.inView) || (a.r.top - b.r.top) || (a.r.left - b.r.left));
  const refs = [];
  const elements = rows.slice(0, max).map(({ el, r, inView }, i) => {
    refs.push(el);
    const tag = el.tagName.toLowerCase();
    const row = { ref: i + 1, role: el.getAttribute('role') || (tag === 'input' ? (el.type || 'text') : tag), name: nameOf(el),
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), inView };
    if ('value' in el && ['input', 'textarea', 'select'].includes(tag) && !['submit', 'button', 'reset'].includes(el.type)) {
      row.value = el.type === 'password' ? (el.value ? '••••' : '') : clip(String(el.value), 40);
    }
    if (el.href && tag === 'a') row.href = clip(el.getAttribute('href'), 60);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') row.disabled = true;
    if (el.checked || el.getAttribute('aria-checked') === 'true') row.checked = true;
    return row;
  });
  window.__agentChromeRefs = refs;
  return { url: location.href, title: document.title,
    viewport: { w: innerWidth, h: innerHeight, sx: Math.round(scrollX), sy: Math.round(scrollY),
      pw: document.documentElement.scrollWidth, ph: document.documentElement.scrollHeight },
    elements, omitted: Math.max(0, rows.length - max) };
}`;

// Resolve a ref or CSS selector, bring it into view, and report a fresh click point plus hit-test result.
export const LOCATE_FN = String.raw`(target) => {
  let el;
  if (typeof target === 'number') {
    el = (window.__agentChromeRefs || [])[target - 1];
    if (!el || !el.isConnected) throw new Error('ref ' + target + ' is stale or unknown; take a new snapshot()');
  } else {
    el = document.querySelector(target);
    if (!el) throw new Error('no element matches ' + JSON.stringify(target));
  }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  const covered = !!hit && hit !== el && !el.contains(hit) && !hit.contains(el);
  return { x: Math.round(x), y: Math.round(y), covered,
    coveredBy: covered ? (hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '')) : undefined };
}`;

// Return the element itself (for objectId-based CDP calls such as file uploads).
export const ELEMENT_FN = String.raw`(target) => {
  const el = typeof target === 'number' ? (window.__agentChromeRefs || [])[target - 1] : document.querySelector(target);
  if (!el || !el.isConnected) throw new Error('element not found: ' + JSON.stringify(target));
  return el;
}`;

export const FOCUS_FN = String.raw`(target) => {
  const el = typeof target === 'number' ? (window.__agentChromeRefs || [])[target - 1] : document.querySelector(target);
  if (!el || !el.isConnected) throw new Error('element not found: ' + JSON.stringify(target));
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.focus();
  return true;
}`;

// After key-by-key typing, fire the events React/Vue/Ember listen for.
export const NOTIFY_INPUT_FN = String.raw`(target) => {
  const el = typeof target === 'number' ? (window.__agentChromeRefs || [])[target - 1] : document.querySelector(target);
  if (!el) return false;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;

export const TEXT_FN = String.raw`(selector) => {
  const el = selector ? document.querySelector(selector) : document.body;
  if (!el) throw new Error('no element matches ' + JSON.stringify(selector));
  return el.innerText;
}`;

export const PAGE_INFO_EXPR = 'JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,' +
  'sx:Math.round(scrollX),sy:Math.round(scrollY),pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})';

/** Compact, context-friendly rendering of a snapshot. */
export function formatSnapshot(snap) {
  const v = snap.viewport;
  const lines = [`${snap.title || '(untitled)'} — ${snap.url}`,
    `viewport ${v.w}x${v.h} scroll ${v.sx},${v.sy} of ${v.pw}x${v.ph}`];
  for (const e of snap.elements) {
    const bits = [`[${e.ref}]`, e.role, JSON.stringify(e.name)];
    if (e.value !== undefined) bits.push(`value=${JSON.stringify(e.value)}`);
    if (e.href) bits.push(`→ ${e.href}`);
    if (e.checked) bits.push('checked');
    if (e.disabled) bits.push('disabled');
    if (!e.inView) bits.push('(offscreen)');
    lines.push(bits.join(' '));
  }
  if (!snap.elements.length) lines.push('(no interactive elements found; try text() or screenshot())');
  if (snap.omitted) lines.push(`… ${snap.omitted} more elements omitted; scroll or snapshot({max}) to see more`);
  return lines.join('\n');
}
