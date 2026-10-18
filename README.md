# lx_dsh_peek

A deliberately small, read-only, **light** LAN view of the active DSH sessions.

- No PIN, no path secret, no relay, no account.
- No input endpoints: the Host plugin only calls `sessionController.list()` and `sessionController.follow()`.
- Autodiscovers active (running) sessions every 3 seconds; there is no session picker.
- Auto-expands assistant reasoning as it streams.
- Streams live background-job output (running commands) from the Host's `jobController`, with a spinner and elapsed time; running tool calls show the same indicator.
- The peek page's default text size is 15px; the pane header shows a moving activity bar and elapsed time while a turn runs.
- Layout follows the viewport orientation:
  - portrait: 2 and 3 panes stack as rows;
  - landscape: 2 and 3 panes sit side by side;
  - 4 panes use a 2×2 grid in both orientations;
  - more than 4 active tasks keeps the first 4 and shows `显示前 4 个`.
- A finished task keeps its pane for 20 seconds so the final output stays visible, then the pane disappears.
- A live `turn/end` makes the whole screen flash three times (and vibrates when the browser allows it).
- The same host plugin can enlarge the official DSH UI's fonts and widen its conversation column from `cordis.patch.yml`, without a patched DMG.

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

When `contentWidth` is nonzero, the same style row also pins the conversation width:

```css
:root, body {
  --dsh-chat-user-width: 1200px;
}
[data-conversation-content] {
  --dsh-chat-content-width: 1200px !important;
  --dsh-composer-card-max-width: 1232px !important;
}
[data-conversation-content] [data-width-handle] {
  display: none !important;
}
```

The official conversation column is adaptive and caps at 920px. The pinned width applies to the transcript, message bubbles, wide tables, composer, and approval/question panels. `contentWidth` defaults to 1200px and accepts `0` or an integer from 640 to 2400. Set `0` to keep the official width and its drag handles; a nonzero width hides the handles because the pinned width ignores their preference.

Install this bundle in the `desktop` profile, launch the official `DeepSeek Harness.app`, and the overrides apply. No patched DMG, no client bundle, and the official app's auto-update does not remove anything under `~/.dsh`.

Set the actual sizes and width in `cordis.patch.yml`:

```yaml
- insert:
    - id: lx-dsh-peek
      name: lx_dsh_peek
      config:
        port: 3082
        contentWidth: 1200
        fontSize: 34
        codeFontSize: 24
        terminalFontSize: 24
```

The width has no official Settings row. The font Settings row still displays the official maximum (22/16/20); change the plugin config, not the Settings row. Keep the profile's `ui-theme` values within the official schema (22/16/20) so the theme plugin validates; the override supplies the larger rendered sizes.

For a package installed from GitHub, do not edit files under `node_modules`. Put an id-targeted override in `~/.dsh/profiles/desktop/cordis.patch.yml` instead:

```yaml
- id: lx-dsh-peek
  config:
    port: 3082
    contentWidth: 1400
    fontSize: 34
    codeFontSize: 24
    terminalFontSize: 24
```

## Open

The plugin listens on `0.0.0.0:3082` and logs the LAN URLs at startup:

```text
[lx-dsh-peek] http://192.168.x.x:3082/
```

Open that URL on a phone connected to the same Wi-Fi. There is no login and no key; the page is read-only and shows conversation and tool output to anyone who can reach the port. Use it only on a trusted LAN, do not port-forward it, and do not expose it from a machine with a public interface.

## Configuration

Change the port, conversation width, or font sizes in `cordis.patch.yml`:

```yaml
- insert:
    - id: lx-dsh-peek
      name: lx_dsh_peek
      config:
        port: 3083
        contentWidth: 1200
        fontSize: 34
        codeFontSize: 24
        terminalFontSize: 24
```

## Development

No runtime dependencies; the plugin uses only Node built-ins.

```sh
node --test tests/server.test.mjs
```

The test boots the plugin with a mock `sessionController` and `jobController`, checks the page, session listing, the SSE snapshot/delta/job-output/flash stream, the read-only response, the injected official-UI font and conversation-width styles, and invalid-width rejection. The page uses CSS `@media (orientation: landscape)` for layout and `matchMedia` for the footer's `竖屏`/`横屏` label.

### Layout

- `src/index.js` — Host plugin, HTTP/SSE listener, session listing and snapshot budget, optional `jobController` forwarding, official-UI font/width style injection.
- `src/page.html` — light mobile page, active-task panes, orientation layout, flash.
- `cordis.patch.yml` — bundle layer that inserts the `lx-dsh-peek` row.
- `tests/server.test.mjs` — keyless mock test.

## License

MIT
