# Changelog

## 0.6.0 — 2026-10-18

- Move the initial transcript to `GET /api/bootstrap`, an ordinary JSON response. The shared SSE now carries only live events/deltas, a `ready` frame, and heartbeats; it no longer writes a large initial snapshot. Mobile networks and proxies can buffer a one-shot SSE response until more data arrives, which is why the first pane could sit on `运行中` with no messages.
- The page bootstraps new panes over HTTP before opening the live stream, and re-bootstraps on a stale stream, visibility resume, or an empty pane. This is the same bootstrap + SSE split used by the DSH mobile bridge.
- Tests now cover the bootstrap endpoint, the no-snapshot SSE stream, and the subagent bootstrap address.

## 0.5.15 — 2026-10-18

- Add an optional terminal renderer at `/?terminal=1`. It formats the newest 60 items into one `<pre>` text buffer (32KB cap) with `你` / `DSH` / `思考` / `工具` / `系统` prefixes, so a pane uses one text node instead of one styled card per event. The normal URL keeps the card view.

## 0.5.14 — 2026-10-18

- Trim snapshot transcripts to the newest 60 items before rendering. The pane is a tail-only viewport; building all 600 historical items on a phone could block the main thread and leave the pane showing only `运行中`.
- If a running pane has no visible content after four seconds, reconnect the shared stream once automatically. This is the automatic equivalent of the manual reload that made the first session show its messages; it also covers a follow attached before the session was ready.

## 0.5.13 — 2026-10-18

- Render live tool calls from `tool-call-delta` frames and hydrate them from the `assistantStream` baseline. A turn that starts with a tool call now shows the tool name and arguments immediately instead of an empty pane; reasoning that ends where a tool call begins is followed by the action row, so it no longer looks cut off. `tool/call` events merge into the live row by call id instead of creating a duplicate.

## 0.5.12 — 2026-10-18

- Add a muted canvas-video keep-awake fallback for browsers that deny Screen Wake Lock. A no-input page is often refused the Wake Lock API; the playing video keeps Android's screen awake so the browser does not suspend the page. A suspended page buffered the whole stream and applied it only at turn end, which looked like "no messages" and a completion flash about a minute late.
- Show the keep-awake state in the footer: `屏幕常亮` (Wake Lock), `视频常亮` (video fallback), or `屏幕可能休眠` (both refused). If the last state appears, set the phone's screen timeout longer or keep the page in the foreground while testing.

## 0.5.11 — 2026-10-18

- Forward the follow snapshot's `assistantStream` baseline and hydrate the in-progress assistant text/reasoning from it. A stream reconnect or a page load in the middle of an answer now restores the partial response instead of resetting the transcript to the durable records and showing nothing until the final message. This is the missing piece behind the phone showing a few seconds of text and then appearing empty after a reconnect.

## 0.5.10 — 2026-10-18

- Replace the subtle yellow opacity pulse with a full-screen black/white completion flash. The overlay starts black, switches to white after one second, and alternates every second for three black phases (six phases total), then hides. Vibration is unchanged.

## 0.5.9 — 2026-10-18

- Fix the phone transcript freezing after a few seconds of streaming. Text and reasoning deltas now append only the new fragment to the live DOM node instead of replacing the whole accumulated text on every token, and live updates scroll only the transcript instead of rescanning every `<pre>` block. Verified at 8× CPU throttling with a 180KB stream: the text kept growing and every sample stayed pinned to the tail.

## 0.5.8 — 2026-10-18

- Add a stream heartbeat and stale-stream recovery. The server emits a data ping every 15 seconds; a visible page that has received no frame for 30 seconds drops the old EventSource and requests a fresh snapshot. This makes the phone recover immediately after the browser suspends the tab, instead of appearing to update only every few minutes.
- Retry Screen Wake Lock on load, on every visibility change, and every 30 seconds. A no-input page cannot force a lock the OS denies, but the retry succeeds where the browser only needed a visible/active document.

## 0.5.7 — 2026-10-18

- Change the default `contentWidth` from `1200px` to `fill`. The old fixed cap widened the pane but left a 1200px text column centered inside it; `fill` maps to a 10000px cap so the official `width: 100%` rules let the transcript, assistant/user text, tables, and composer use the whole conversation pane. A number from 640 to 2400 still pins a fixed measure, and 0 keeps the official width.

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
