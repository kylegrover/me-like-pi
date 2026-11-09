---
name: agent-chrome
description: Control the dedicated agent Chrome (its own persistent profile and logins) to click, type, navigate, fill forms, screenshot, or read JS-rendered and logged-in pages. Not for public pages a plain fetch can read.
compatibility: Node 22+, Google Chrome. Local loopback only.
---

# agent-chrome

Drives a **separate agent Chrome profile** over the local DevTools protocol. It never
touches the user's own browser or default Chrome profile. Logins made in the agent
window persist. No telemetry, cloud, or update checks; it talks only to 127.0.0.1.

Run as `node <this skill dir>/scripts/agent-chrome.mjs ...` (below: `agent-chrome`).

## When to use, when not

- Public docs, APIs, static pages: use a plain fetch or `curl`, not the browser.
- Use the browser for interaction, the agent profile's logged-in sessions, JS-rendered
  pages, or when a fetch returns an empty shell.
- Login walls, passwords, MFA, CAPTCHAs, payments, consent or account choices: **stop and
  ask the user** to do it in the agent window (`show()` brings the tab forward).

## Starting

- `agent-chrome status` first. If not running, **ask the user** before `agent-chrome start`
  (it opens a visible window). Never start a different browser or profile.
- One browser task at a time. If several agents need it, give each its own
  `--session NAME`; sessions track their own tabs but share one browser and cookies.

## Running snippets

```bash
agent-chrome <<'JS'
await open('https://example.com')
return snapshot()
JS
```

Snippets are async JavaScript with helpers in scope; `return` a value to print it. State
persists between calls only as the session's current tab, so chain small calls:
look, act, verify.

- `open(url)` new background tab owned by this session; `goto(url)` in the current tab.
- `tabs()`, `use(tab)` (index, id prefix) to work in an existing tab without owning it.
- `snapshot()` lists interactive elements as `[ref] role "name"` with viewport position.
  Prefer it over screenshots. Refs die on navigation; re-snapshot after page changes.
- `click(ref | 'css' | {x, y})` refuses if another element covers the target; dismiss
  the overlay rather than forcing coordinates.
- `fill(ref, text)` for form fields (works with React/Vue); `type(text)` inserts at focus;
  `press('Enter')`, `press('a', ['ctrl'])`.
- `text(selector?)` visible text (truncated at 8,000 chars); `js(expr)` for targeted
  extraction; `js(expr, {frame: 'url-part'})` inside an iframe.
- `screenshot()` saves a PNG and returns its path; read the image only when layout or
  visuals matter. `waitFor(selector)`, `waitForIdle()` after async updates.
- `dialog(true)` when `info()` reports an open alert/confirm.
- `raw(method, params)` is raw CDP for anything else.

## Finishing

- Verify the outcome (`info()`, `text()`, snapshot) before reporting success.
- `agent-chrome cleanup` closes tabs this session opened. Use `release` instead when the
  user should keep a tab (a draft, a result page). Never close tabs you didn't open.
- Report what was done and where; include screenshot paths rather than descriptions
  of images when evidence matters.
