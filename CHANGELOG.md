# Changelog

## 0.5.6 — 2026-10-18

- Follow subagent sessions with their durable parent address instead of a plain session address. The session list now exposes `parentSessionId`, the page passes it alongside each subagent `sessionId`, and the server follows `{ kind: 'subagent', parentSessionId, childSessionId, mode: 'unknown' }`. This fixes the pane that showed the subagent's approval/transcript text and then stayed on `连接中` because the Host rejected `{ kind: 'session' }` for a subagent child.

## 0.5.5 — 2026-10-18

- Fix a snapshot regression: replaying a session's history no longer destroys a pane when the history contains an older `turn/end`. Only a live `turn/end` removes the pane; historical turn boundaries are ignored during snapshot rendering.

## 0.5.4 — 2026-10-18

- Make the phone page strictly view-only: `pointer-events: none`, `touch-action: none`, no text selection or callout, zoom disabled, and captured listeners that swallow context menu, selection, drag, wheel, touchmove, and click. All scrollbars are hidden.
- Pane bodies, the job band, tool output, and job output use `overflow: hidden` and are driven to their newest page programmatically. Tool results render as static text instead of a collapsible `<details>` tap target.
- Remove the pointerdown Wake Lock gesture; request the lock on load and whenever the page becomes visible instead.

## 0.5.3 — 2026-10-18

- Remove the `任务结束` toast. Completion feedback is now only the transient full-screen flash (and vibration where allowed).
- Destroy a pane as soon as its task ends. A live `turn/end` removes it immediately, and polling removes any pane whose session is no longer running instead of keeping completed panes for 20 seconds.

## 0.5.2 — 2026-10-18

- Keep every pane pinned to its newest line. The page now follows new reasoning, tool output, and transcript rows unconditionally instead of waiting until the reader is within 120px of the bottom; it also re-pins after grid/job-band changes and once per second.

## 0.5.1 — 2026-10-18

- Multiplex every active pane over one SSE connection. The server tags each session's transcript and job frames with `sessionId`; the page routes them and reconnects only when the visible pane set changes. This fixes a second pane staying on `连接中` when a mobile browser queued its extra EventSource.
- Close JSON and HTML sockets with `Connection: close`, leaving the pane stream as the only long-lived browser connection.

## 0.5.0 — 2026-10-18

- Widen the official DSH conversation column by injecting `--dsh-chat-content-width` and `--dsh-composer-card-max-width` overrides. Defaults to 1200px; configure with `contentWidth` (0 keeps the official adaptive width and drag handles).
- Hide the official width drag handles while a pinned width is active, since the pinned width ignores their preference.

## 0.4.0 — 2026-10-18

- Inject a host-side `!important` style into every DSH UI page, overriding the official theme's inline font variables. This lets the official DSH build use a larger font without a patched DMG; defaults are 34px content, 24px code, 24px terminal.
- Configure the override in `cordis.patch.yml` (`fontSize`, `codeFontSize`, `terminalFontSize`).

## 0.3.0 — 2026-10-18

- Auto-expand assistant reasoning in the transcript.
- Stream live background-job output (bash commands) over the session SSE.
- Show running tool/job spinners, per-pane and per-job elapsed time, and a pane activity bar.
- Raise the default font to 15px.

## 0.2.0 — 2026-10-18

- Light theme by default.
- Remove the session picker; autodiscover active sessions.
- Add 1/2/3/4-pane layouts, capped at 4 active tasks.
- Add portrait/landscape layout adaptation and a `竖屏`/`横屏` footer label.
- Flash the screen three times when a live `turn/end` arrives.
- Keep a completed pane for 20 seconds.

## 0.1.0 — 2026-10-18

- Initial read-only LAN page with a session picker and single transcript.
