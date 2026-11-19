# lx_dsh_peek

A deliberately small, read-only, **light** LAN view of the active DSH sessions — and of the active ZCode tasks on the same machine.

- No PIN, no path secret, no relay, no account.
- No input endpoints and no page input: the Host plugin only calls `sessionController.list()` and `sessionController.follow()`; the page disables scrolling, zoom, selection, context menus, drags, and taps.
- Autodiscovers active (running) sessions every 3 seconds; there is no session picker. Subagent children are included and followed with their durable parent address, so their panes show the child transcript instead of failing to connect.
- ZCode tasks run in the ZCode app appear on the same page with live reasoning/text/tool streaming and the same completion flash; recently finished ZCode tasks stay listed (✓/✗ + time) so a missed flash still answers "完成了没有". See the [ZCode sessions](#zcode-sessions) section.
- Auto-expands assistant reasoning as it streams. Text and reasoning deltas are appended to the live node incrementally, so a long answer does not rebuild the whole transcript on every token. A reconnect or mid-turn page load restores the in-progress answer from the snapshot's `assistantStream` baseline instead of clearing the pane.
- Tool calls are rendered from `tool-call-delta` and the same baseline. A tool-only turn shows the action name/arguments immediately instead of an empty pane, and reasoning that ends when a tool call begins no longer looks truncated without a following action row.
- Every pane shows only its newest page and stays pinned to its tail. The transcript, job band, and tool output are paged programmatically; the reader cannot scroll them and no scrollbar is rendered. Snapshots are trimmed to the newest 60 items before rendering, and a running pane that still has no visible content after four seconds reconnects once automatically.
- Streams live background-job output (running commands) from the Host's `jobController`, with a spinner and elapsed time; running tool calls show the same indicator.
- All visible panes share one SSE connection; every frame carries its `sessionId`. This avoids the mobile per-origin connection limit that left a second pane stuck on `连接中`.
- The footer shows the keep-awake state (`屏幕常亮` / `视频常亮` / `屏幕可能休眠`). When Screen Wake Lock is denied — common for a no-input page — a tiny muted canvas video plays in the background to keep Android's screen awake, so the browser does not suspend the page and buffer updates until the screen wakes.
- The server sends a data heartbeat every 15 seconds; a visible page that sees no frame for 30 seconds reopens the stream and refreshes its snapshot. This recovers immediately after a phone suspends the tab or socket, and the no-input page retries Screen Wake Lock on load, visibility changes, and every 30 seconds.
- The peek page's default text size is 15px; the pane header shows a moving activity bar and elapsed time while a turn runs.
- Layout follows the viewport orientation:
  - portrait: 2 and 3 panes stack as rows;
  - landscape: 2 and 3 panes sit side by side;
  - 4 panes use a 2×2 grid in both orientations;
  - more than 4 active tasks keeps the first 4 and shows `显示前 4 个`.
- A live `turn/end` destroys that task's pane immediately and flashes the whole background black/white at one-second intervals for three black phases (six phases total), then hides. It vibrates when the browser allows it. There is no persistent `任务结束` banner.
- The same host plugin can enlarge the official DSH UI's fonts, widen its conversation column, and raise its composer height from `cordis.patch.yml`, without a patched DMG.

## Install

This repository is a DSH **bundle**: `package.json` declares `dsh.bundle.patch`, and `cordis.patch.yml` inserts the host row.

### From GitHub

Fully quit `DeepSeek Harness.app` first. If this checkout was previously linked into the desktop profile, replace it:

```sh
dsh plugin --profile desktop remove lx_dsh_peek
dsh plugin --profile desktop add github:liuluopeng/dsh_peeker
```

A clean profile only needs the second command. For a reproducible install, append a commit to the spec:

```sh
dsh plugin --profile desktop add github:liuluopeng/dsh_peeker#<commit-sha>
```

Reopen `DeepSeek Harness.app` after the command finishes. The plugin has no build step, so pnpm does not need `allowBuilds` approval.

To update a GitHub install, fully quit the app, rerun the same `add` command (it re-resolves the repository's `main`), then reopen the app.

### From a local checkout

From the directory that contains this checkout:

```sh
cd /Volumes/six/FLUT
dsh plugin --profile desktop add ./lx_dsh_peek
```

The profile records an absolute `link:` to the checkout. Restart DSH after installing or after moving/relinking the checkout; the running process keeps the package directory it loaded at startup. The plugin requires Node.js ≥ 20 and DSH `>=0.2.0-rc.1 <0.3.0` (`engines.dsh`).

## Official DSH font and conversation width without a patched DMG

The same host plugin can enlarge and widen the **official** DSH UI. It listens to the Host's `webserver/index-inject` event and injects one style row into every DSH index page:

```css
:root, body {
  --dsh-content-font-size: 34px !important;
  --dsh-code-font-size: 24px !important;
  --dsh-terminal-font-size: 24px !important;
}
```

The official theme writes its font variables to `body` as normal inline styles; the `!important` stylesheet rule wins, so the rendered UI uses these values even though the official Settings schema still caps the text row at 22px (code 16, terminal 20).

By default `contentWidth: fill` makes the conversation content use the whole center pane; `0` keeps the official width:

```css
:root, body {
  --dsh-chat-user-width: 10000px;
}
[data-conversation-content] {
  --dsh-chat-content-width: 10000px !important;
  --dsh-composer-card-max-width: 10032px !important;
}
[data-conversation-content] [data-width-handle] {
  display: none !important;
}
```

`contentWidth: fill` injects a cap above any real viewport, so the official `width: 100%` rules let the transcript, assistant/user text, wide tables, and composer consume the entire center pane. Set `contentWidth` to an integer from 640 to 2400 for a centered fixed measure, `0` to keep the official width and its drag handles, or `fill` for the whole pane. Any nonzero number hides the handles because the pinned width ignores their preference.

The conversation still cannot exceed the center pane. On desktop the left sidebar occupies 264–420px and an open right sidebar starts at 300px, so collapse the right sidebar with `⌘⌥B` and the left sidebar with `⌘B` (macOS desktop), or drag them narrower, to give the text more room.

Install this bundle in the `desktop` profile, launch the official `DeepSeek Harness.app`, and the overrides apply. No patched DMG, no client bundle, and the official app's auto-update does not remove anything under `~/.dsh`.

Set the actual sizes and width in `cordis.patch.yml`:

```yaml
- insert:
    - id: lx-dsh-peek
      name: lx_dsh_peek
      config:
        port: 3082
        contentWidth: fill
        fontSize: 34
        codeFontSize: 24
        terminalFontSize: 24
        # px min-height of the official input box; 0 keeps the official height.
        # The scroll area starts scrolling after composerHeight + 160px.
        composerHeight: 200
        archive:
          enabled: true
          apiBase: http://192.168.31.58:23000
          token: ''                                  # or username/passwordFile below
          # username: dsh_archive
          # passwordFile: ~/.dsh/lx-dsh-peek-archive/password
```

The width has no official Settings row. The font Settings row still displays the official maximum (22/16/20); change the plugin config, not the Settings row. Keep the profile's `ui-theme` values within the official schema (22/16/20) so the theme plugin validates; the override supplies the larger rendered sizes.

For a package installed from GitHub, do not edit files under `node_modules`. Put an id-targeted override in `~/.dsh/profiles/desktop/cordis.patch.yml` instead:

```yaml
- id: lx-dsh-peek
  config:
    port: 3082
    contentWidth: fill
    fontSize: 34
    codeFontSize: 24
    terminalFontSize: 24
    # px min-height of the official input box; 0 keeps the official height.
    composerHeight: 200
```

## ZCode sessions

The plugin also watches ZCode (the desktop coding agent) without any ZCode-side setup. ZCode persists every session in `~/.zcode/cli/db/db.sqlite` (WAL mode); the plugin opens that file read-only with Node's built-in `node:sqlite` — no new dependencies, no ZCode plugin, no relay. ZCode sessions are listed under ids prefixed `z:`, so they never collide with DSH session ids.

- A ZCode task is "running" while the store says so, not while writes look recent: an uncompleted assistant message is an in-flight turn however long it goes quiet (tool runs are silent for their whole duration, and measured turns run for hours), a tool part still marked `running` is a quiet command in flight, a turn whose newest visible row is still the user's own message is queued (model scheduling can sit out minutes before the first token), and a recorded `last_outcome` only settles the session when nothing has written since — outcomes stay from the previous turn while the next one runs. A turn/end is emitted only after two consecutive not-running polls, so a misread never flashes over a live task.
- Long replies are not truncated on commit: streamed text and reasoning are capped at 65 536 characters in live events (snapshots keep the smaller history budget), so a finished reply never visibly loses its tail the moment it settles.
- The transcript is mapped onto the same events the page already renders: user/assistant messages, reasoning, tool calls and their outputs. An in-flight assistant message's text and reasoning are deliberately left out of the snapshot and stream in as live deltas right after attach, which also gives mid-turn reconnects the streaming cursor instead of a pasted paragraph.
- Updates are change-driven: the watcher stats the store files every ~150 ms (a kqueue directory watch misses SQLite's in-place WAL appends on macOS, and ZCode exposes no subscribable event API) and wakes within ~150 ms of a commit, skipping content queries on cycles where `PRAGMA data_version` shows nothing was written.
- When a watched task's turn settles, the stream emits the same live `turn/end` as DSH: the pane flashes three times, vibrates where allowed, and disappears. Because ZCode writes `last_outcome` (`completed` / `error` / `interrupted`), tasks that finished in the last 30 minutes stay listed in one muted line under the header — open the page late and it still answers whether the task succeeded.
- Everything degrades silently: if `node:sqlite` is unavailable (the DSH runtime ships Node ≥ 22.5, so it is), the store is missing, or a read fails, ZCode simply contributes no sessions and DSH keeps working.

Config rows (both optional; ZCode support is on by default):

```yaml
config:
  # false turns the ZCode source off entirely.
  zcode: true
  # Override when ZCode uses a non-default data root. Default: ~/.zcode/cli/db/db.sqlite
  zcodeDbPath: /Volumes/six/zcode/cli/db/db.sqlite
```

For a GitHub install, put the same rows in `~/.dsh/profiles/desktop/cordis.patch.yml` under the `lx-dsh-peek` id instead of editing `node_modules`.

The peek page is still fully read-only; the ZCode store is opened with SQLite read-only mode, and all queries are plain SELECTs.

## Open

The plugin listens on `0.0.0.0:3082` and logs the LAN URLs at startup:

```text
[lx-dsh-peek] http://192.168.x.x:3082/
```

Open that URL on a phone connected to the same Wi-Fi. There is no login and no key; the page is read-only and shows conversation and tool output to anyone who can reach the port. Use it only on a trusted LAN, do not port-forward it, and do not expose it from a machine with a public interface.

### Terminal mode

Open `http://<lan-ip>:3082/?terminal=1` for the lightest rendering path: the newest 60 items are formatted into one `<pre>` text buffer (capped at 32KB) with `你`, `DSH`, `思考`, `工具`, and `系统` prefixes. It uses one text node for the transcript instead of one styled card per event. The normal URL keeps the card view.

The default card view creates one article per user/assistant message, tool call, and tool result; a long agent session can accumulate hundreds. Snapshots are trimmed to the newest 60 items before rendering, and terminal mode removes the per-item DOM entirely.

### Transport

- `GET /api/sessions` every 3 seconds discovers active sessions.
- `GET /api/bootstrap?sessionId=…` (and `parentSessionId=…` for subagents) still returns the initial history as ordinary JSON, but the page no longer needs it: the live stream opens with the history itself.
- One shared `GET /api/stream` SSE connection carries everything for the visible sessions, in a single ordered sequence per connection: the follow **snapshot first** (chunked into small `final:false` frames of ≤20 records plus a `final:true` frame carrying the `assistantStream` baseline), then durable events with their dense `seq`, assistant-stream deltas with `attemptId`/`index`, job frames, data pings every 5 s, and the `turn/end` flash. The page drops `seq ≤ lastSeq`, resyncs by reopening on a gap or a skipped chunk index, and commits each streamed draft to its durable row by shared `turn`/`step` — the same ordering discipline the official web client and DSH Go follow, which is what keeps a suspended phone or a flaky LAN from scrambling the transcript.
- There is no WebSocket. For a read-only monitor, server-to-client SSE plus chunked in-stream snapshots reconnects automatically; bidirectional remote control needs a WebSocket/Gateway or relay instead.

## Configuration

Change the port, conversation width, or font sizes in `cordis.patch.yml`:

```yaml
- insert:
    - id: lx-dsh-peek
      name: lx_dsh_peek
      config:
        port: 3083
        contentWidth: fill
        fontSize: 34
        codeFontSize: 24
        terminalFontSize: 24
        # px min-height of the official input box; 0 keeps the official height.
        # The scroll area starts scrolling after composerHeight + 160px.
        composerHeight: 200
        archive:
          enabled: true
          apiBase: http://192.168.31.58:23000
          token: ''                                  # or username/passwordFile below
          # username: dsh_archive
          # passwordFile: ~/.dsh/lx-dsh-peek-archive/password
```

## Session archive (PG)

The archive keeps the viewer's read-only promise and adds a second, always-on
output: every durable Session event is mirrored into PostgreSQL on the NAS
(`dayly_service`, tables `dsh_sessions` / `dsh_events`), independent of whether
anyone is watching the page.

**What is stored.** `user/message`, `assistant/message` (text blocks, reasoning
blocks, tool calls), `tool/call`, `tool/result`, `turn/*`, `step/*`,
`approval/*`, `todo/write`, `session/title`, `compaction/*`, `subagent/*` — the
durable log, append-only, deduplicated by `(session_id, seq)`. Only
`assistant/message.stream` (the per-token duplicate of those content blocks,
~79 % of the bytes) is dropped unless `storeStream: true`.

**Why it cannot lose messages.** Three gaps in the viewer do not apply here:

| Viewer gap | Archive behaviour |
|---|---|
| one bounded `maxMessages` snapshot, no back-paging | the whole log is read through `sessionQuery.observeSession()` — the Host service the Session Controller itself uses — which returns header + complete event prefix for attached *and* cold sessions without activating an Agent (no subagent address/mode guessing either). That service is resolved lazily through `ctx.get()` because it is not in the plugin's `inject` list (requiring it would keep the entire peek plugin pending on a differently composed profile), and Cordis rejects a plain property read of an uninjected service. If it is not composed, the archive falls back to `follow()` (cursor only, abandoned before `next()` so a cold session is never promoted) plus backward `page({ beforeSeq })` until `hasMore === false` |
| strings shrunk to 4000 chars | payloads forwarded unshrunk |
| capture only while a browser is connected | live capture is the Host `session/event` firehose |

Batches are byte-bounded (~1.5 MB) and a `413` response halves the batch and
retries, so a single oversized tool result cannot wedge the queue; per-request
session rows are narrowed to the sessions that batch actually references.
A first full backfill of this machine's history measured 130 sessions /
150 364 events / 45 event kinds / 385 MB with zero failures — two pre-v1
format-v0 sessions are refused by the session-format migration itself and are
reported rather than retried.

Delivery is at-least-once: a failed POST is written to
`~/.dsh/lx-dsh-peek-archive/spool/*.json` and retried until the NAS accepts it,
so a NAS restart or an expired credential loses nothing.

**Credentials.** Either paste a login JWT (30-day lifetime), or give the plugin
an account and let it refresh itself:

```yaml
archive:
  username: dsh_archive
  passwordFile: ~/.dsh/lx-dsh-peek-archive/password   # chmod 600
```

A refreshed token is cached in `~/.dsh/lx-dsh-peek-archive/auth.json` (0600).
`GET /api/archive/status` reports queue depth, spooled batches, failures, and
remaining token days; `POST`-less `GET /api/archive/flush` forces a delivery
attempt.

**Reading it back** (JWT required):

```sh
curl -H "Authorization: Bearer $JWT" "$NAS/api/dsh/archive/sessions?q=新概念"
curl -H "Authorization: Bearer $JWT" "$NAS/api/dsh/archive/search?q=TTML"
curl -H "Authorization: Bearer $JWT" "$NAS/api/dsh/archive/sessions/<id>/events?limit=100"
```

## Development

No runtime dependencies; the plugin uses only Node built-ins (`node:sqlite` needs Node ≥ 22.5 for the ZCode source; without it the rest still works).

```sh
node --test tests/server.test.mjs tests/zcode.test.mjs tests/archive.test.mjs tests/archive.integration.test.mjs
```

The first test boots the plugin with a mock `sessionController` and `jobController`, checks the page (including its no-input, hidden-scrollbar, tail-only markers), session listing, the SSE snapshot/delta/job-output/flash stream, multiplexing two sessions over one tagged stream, the read-only response, the injected official-UI font and conversation-width styles, and invalid-width rejection. The second builds a temporary SQLite store with ZCode's schema, seeds a running task (in-flight assistant message, streaming text part, running tool part) and a finished one, and asserts the merged session list, the bootstrap event mapping, and the watcher's live deltas plus its completion flash. The page uses CSS `@media (orientation: landscape)` for layout and `matchMedia` for the footer's `竖屏`/`横屏` label.

### Layout

- `src/index.js` — Host plugin, HTTP/SSE listener, session listing and snapshot budget, optional `jobController` forwarding, multiplexed per-session frames, official-UI font/width style injection, ZCode source wiring.
- `src/zcode.js` — read-only ZCode adapter over `~/.zcode/cli/db/db.sqlite`: running detection, snapshot mapping, store-polling watcher.
- `src/archive.js` — always-on session archive: live `session/event` capture, full-log backfill through `sessionQuery.observeSession` (fallback `follow`/`page`), byte-bounded batches with `413` splitting, spool on outage, JWT auto-refresh.
- `src/page.html` — light mobile page, active-task panes, one shared SSE connection, orientation layout, flash, recently-finished strip.
- `cordis.patch.yml` — bundle layer that inserts the `lx-dsh-peek` row.
- `tests/server.test.mjs`, `tests/zcode.test.mjs` — keyless mock tests.
- `tests/archive.test.mjs`, `tests/archive.integration.test.mjs` — archive pure helpers, plus a fake Host context and fake NAS proving full-log backfill, no promotion, live capture, spool-and-recover, and token refresh.

## License

MIT
