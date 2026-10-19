# lx_dsh_peek

A deliberately small, read-only, **light** LAN view of the active DSH sessions.

- No PIN, no path secret, no relay, no account.
- No input endpoints and no page input: the Host plugin only calls `sessionController.list()` and `sessionController.follow()`; the page disables scrolling, zoom, selection, context menus, drags, and taps.
- Autodiscovers active (running) sessions every 3 seconds; there is no session picker. Subagent children are included and followed with their durable parent address, so their panes show the child transcript instead of failing to connect.
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
- The same host plugin can enlarge the official DSH UI's fonts, set the conversation column width, and raise its composer height from `cordis.patch.yml`, without a patched DMG.

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

By default `contentWidth: 920` pins a readable column (the proportion in the screenshot). `fill` uses the whole conversation pane; `0` keeps the official width:

```css
:root, body {
  --dsh-chat-user-width: 920px;
}
[data-conversation-content] {
  --dsh-chat-content-width: 920px !important;
  --dsh-composer-card-max-width: 952px !important;
}
[data-conversation-content] [data-width-handle] {
  display: none !important;
}
```

With `contentWidth: 920` the conversation column is a centered 920px measure. `fill` instead injects a cap above any real viewport, so the official `width: 100%` rules let the transcript, assistant/user text, wide tables, and composer consume the entire center pane. Set `contentWidth` to an integer from 640 to 2400, `0` to keep the official width and its drag handles, or `fill` for the whole pane. Any nonzero value hides the handles because the pinned width ignores their preference.

The conversation still cannot exceed the center pane. On desktop the left sidebar occupies 264–420px and an open right sidebar starts at 300px, so collapse the right sidebar with `⌘⌥B` and the left sidebar with `⌘B` (macOS desktop), or drag them narrower, to give the text more room.

Install this bundle in the `desktop` profile, launch the official `DeepSeek Harness.app`, and the overrides apply. No patched DMG, no client bundle, and the official app's auto-update does not remove anything under `~/.dsh`.

Set the actual sizes and width in `cordis.patch.yml`:

```yaml
- insert:
    - id: lx-dsh-peek
      name: lx_dsh_peek
      config:
        port: 3082
        contentWidth: 920
        fontSize: 34
        codeFontSize: 24
        terminalFontSize: 24
        # px min-height of the official input box; 0 keeps the official height.
        # The scroll area starts scrolling after composerHeight + 160px.
        composerHeight: 200
```

The width has no official Settings row. The font Settings row still displays the official maximum (22/16/20); change the plugin config, not the Settings row. Keep the profile's `ui-theme` values within the official schema (22/16/20) so the theme plugin validates; the override supplies the larger rendered sizes.

For a package installed from GitHub, do not edit files under `node_modules`. Put an id-targeted override in `~/.dsh/profiles/desktop/cordis.patch.yml` instead:

```yaml
- id: lx-dsh-peek
  config:
    port: 3082
    contentWidth: 920
    fontSize: 34
    codeFontSize: 24
    terminalFontSize: 24
    # px min-height of the official input box; 0 keeps the official height.
    composerHeight: 200
```

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
- `GET /api/bootstrap?sessionId=…` (and `parentSessionId=…` for subagents) returns the initial history and the in-progress `assistantStream` baseline as ordinary JSON.
- One shared `GET /api/stream` SSE connection carries only live events and deltas (plus a `ready` frame and data heartbeats). The initial transcript is deliberately not sent over SSE: a large one-shot SSE write can be buffered by mobile networks/proxies until more data arrives, which looks like a pane stuck on `运行中`.
- There is no WebSocket. For a read-only monitor, server-to-client SSE plus a normal HTTP bootstrap is simpler and reconnects automatically; bidirectional remote control needs a WebSocket/Gateway or relay instead.

## Configuration

Change the port, conversation width, or font sizes in `cordis.patch.yml`:

```yaml
- insert:
    - id: lx-dsh-peek
      name: lx_dsh_peek
      config:
        port: 3083
        contentWidth: 920
        fontSize: 34
        codeFontSize: 24
        terminalFontSize: 24
        # px min-height of the official input box; 0 keeps the official height.
        # The scroll area starts scrolling after composerHeight + 160px.
        composerHeight: 200
```

## Development

No runtime dependencies; the plugin uses only Node built-ins.

```sh
node --test tests/server.test.mjs
```

The test boots the plugin with a mock `sessionController` and `jobController`, checks the page (including its no-input, hidden-scrollbar, tail-only markers), session listing, the SSE snapshot/delta/job-output/flash stream, multiplexing two sessions over one tagged stream, the read-only response, the injected official-UI font and conversation-width styles, and invalid-width rejection. The page uses CSS `@media (orientation: landscape)` for layout and `matchMedia` for the footer's `竖屏`/`横屏` label.

### Layout

- `src/index.js` — Host plugin, HTTP/SSE listener, session listing and snapshot budget, optional `jobController` forwarding, multiplexed per-session frames, official-UI font/width style injection.
- `src/page.html` — light mobile page, active-task panes, one shared SSE connection, orientation layout, flash.
- `cordis.patch.yml` — bundle layer that inserts the `lx-dsh-peek` row.
- `tests/server.test.mjs` — keyless mock test.

## License

MIT
