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

![Live reasoning, running tool and background-command output](docs/preview-live.png)

![4-pane layout](docs/preview-4.png)

## Install

This repository is a DSH **bundle**: `package.json` declares `dsh.bundle.patch`, and `cordis.patch.yml` inserts the host row.

From the directory that contains this checkout:

```sh
cd /Volumes/six/FLUT
dsh plugin --profile desktop add ./lx_dsh_peek
```

The profile records an absolute `link:` to this checkout, so this plugin currently lives at `/Volumes/six/FLUT/lx_dsh_peek`. Restart DSH after installing or after moving/relinking the checkout; the running process keeps the package directory it loaded at startup. The plugin requires Node.js ≥ 20 and DSH `>=0.2.0-rc.1 <0.3.0` (`engines.dsh`).

## Official DSH font without a patched DMG

The same host plugin can enlarge the **official** DSH UI. It listens to the Host's `webserver/index-inject` event and injects one style row into every DSH index page:

```css
:root, body {
  --dsh-content-font-size: 34px !important;
  --dsh-code-font-size: 24px !important;
  --dsh-terminal-font-size: 24px !important;
}
```

The official theme writes its font variables to `body` as normal inline styles; the `!important` stylesheet rule wins, so the rendered UI uses these values even though the official Settings schema still caps the text row at 22px (code 16, terminal 20). Install this bundle in the `desktop` profile, launch the official `DeepSeek Harness.app`, and the override applies. No patched DMG, no client bundle, and the official app's auto-update does not remove anything under `~/.dsh`.

Set the actual sizes in `cordis.patch.yml`:

```yaml
- insert:
    - id: lx-dsh-peek
      name: lx_dsh_peek
      config:
        port: 3082
        fontSize: 34
        codeFontSize: 24
        terminalFontSize: 24
```

The Settings row still displays the official maximum (22/16/20); change the plugin config, not the Settings row. Keep the profile's `ui-theme` values within the official schema (22/16/20) so the theme plugin validates; the override supplies the larger rendered sizes.

## Open

The plugin listens on `0.0.0.0:3082` and logs the LAN URLs at startup:

```text
[lx-dsh-peek] http://192.168.x.x:3082/
```

Open that URL on a phone connected to the same Wi-Fi. There is no login and no key; the page is read-only and shows conversation and tool output to anyone who can reach the port. Use it only on a trusted LAN, do not port-forward it, and do not expose it from a machine with a public interface.

## Configuration

Change the port in `cordis.patch.yml`:

```yaml
- insert:
    - id: lx-dsh-peek
      name: lx_dsh_peek
      config:
        port: 3083
        fontSize: 34
        codeFontSize: 24
        terminalFontSize: 24
```

## Development

No runtime dependencies; the plugin uses only Node built-ins.

```sh
node --test tests/server.test.mjs
```

The test boots the plugin with a mock `sessionController` and `jobController`, checks the page, session listing, the SSE snapshot/delta/job-output/flash stream, the read-only response, and the injected official-UI font style. The page uses CSS `@media (orientation: landscape)` for layout and `matchMedia` for the footer's `竖屏`/`横屏` label.

### Layout

- `src/index.js` — Host plugin, HTTP/SSE listener, session listing and snapshot budget, optional `jobController` forwarding.
- `src/page.html` — light mobile page, active-task panes, orientation layout, flash.
- `cordis.patch.yml` — bundle layer that inserts the `lx-dsh-peek` row.
- `tests/server.test.mjs` — keyless mock test.

## License

MIT
