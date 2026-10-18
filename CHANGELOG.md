# Changelog

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
