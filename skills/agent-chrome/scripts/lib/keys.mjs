// US-layout key mapping for CDP Input.dispatchKeyEvent.
// Ported from browser-use/browser-harness helpers.py (MIT, see ../../NOTICE).

export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

// key -> [windowsVirtualKeyCode, code, text]
export const NAMED_KEYS = {
  Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab', '\t'], Backspace: [8, 'Backspace', ''],
  Escape: [27, 'Escape', ''], Delete: [46, 'Delete', ''], ' ': [32, 'Space', ' '],
  ArrowLeft: [37, 'ArrowLeft', ''], ArrowUp: [38, 'ArrowUp', ''],
  ArrowRight: [39, 'ArrowRight', ''], ArrowDown: [40, 'ArrowDown', ''],
  Home: [36, 'Home', ''], End: [35, 'End', ''], PageUp: [33, 'PageUp', ''], PageDown: [34, 'PageDown', ''],
};

const PUNCTUATION = {
  '`': ['Backquote', 192], '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219],
  ']': ['BracketRight', 221], '\\': ['Backslash', 220], ';': ['Semicolon', 186], "'": ['Quote', 222],
  ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191],
};

// Characters needing Shift on a US layout -> unshifted character on the same physical key.
const SHIFTED = {
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8',
  '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'",
  '<': ',', '>': '.', '?': '/',
};

/** [code, virtualKey, needsShift] for one printable ASCII char, or null (non-US chars insert via text). */
export function printableKey(char) {
  const base = SHIFTED[char] ?? char;
  const needsShift = char in SHIFTED || (char !== char.toLowerCase() && char === char.toUpperCase());
  if (/^[a-z]$/i.test(base)) return [`Key${base.toUpperCase()}`, base.toUpperCase().charCodeAt(0), needsShift];
  if (/^[0-9]$/.test(base)) return [`Digit${base}`, base.charCodeAt(0), needsShift];
  if (PUNCTUATION[base]) return [...PUNCTUATION[base], needsShift];
  return null;
}

/** The CDP key events a real US keyboard sends for `key` with a modifier bitfield. */
export function keyEvents(key, modifiers = 0) {
  let vk, code, text;
  if (NAMED_KEYS[key]) [vk, code, text] = NAMED_KEYS[key];
  else if ([...key].length === 1) {
    text = key;
    const resolved = printableKey(key);
    if (resolved) {
      let needsShift;
      [code, vk, needsShift] = resolved;
      if (needsShift && !(modifiers & (MOD.alt | MOD.ctrl | MOD.meta))) modifiers |= MOD.shift;
    } else { code = ''; vk = 0; }
  } else { vk = 0; code = key; text = ''; }
  const base = { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  const shortcut = modifiers & (MOD.alt | MOD.ctrl | MOD.meta);
  const printable = [...key].length === 1 && !!text && !shortcut;
  const events = [{ type: 'keyDown', ...base, ...(printable || !text ? {} : { text }) }];
  if (printable) events.push({ type: 'char', ...base, text });
  events.push({ type: 'keyUp', ...base });
  return events;
}
