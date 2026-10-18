# lx_dsh_peek

A deliberately small, read-only, **light** LAN view of the active DSH sessions.

- No PIN, no path secret, no relay, no account.
- No input endpoints: the Host plugin only calls `sessionController.list()` and `sessionController.follow()`.
- Autodiscovers active (running) sessions every 3 seconds; there is no session picker.
- Layout follows the viewport orientation:
  - portrait: 2 and 3 panes stack as rows;
  - landscape: 2 and 3 panes sit side by side;
  - 4 panes use a 2×2 grid in both orientations;
  - more than 4 active tasks keeps the first 4 and shows `显示前 4 个`.
- A finished task keeps its pane for 20 seconds so the final output stays visible, then the pane disappears.
- A live `turn/end` makes the whole screen flash three times (and vibrates when the browser allows it).

![4-pane layout](docs/preview-4.png)

## Install

This repository is a DSH **bundle**: `package.json` declares `dsh.bundle.patch`, and `cordis.patch.yml` inserts the host row.

From the directory that contains this checkout:

```sh
cd /Volumes/six/FLUT
dsh plugin --profile desktop add ./lx_dsh_peek
```

The profile records an absolute `link:` to this checkout, so this plugin currently lives at `/Volumes/six/FLUT/lx_dsh_peek`. Restart DSH after installing or after moving/relinking the checkout; the running process keeps the package directory it loaded at startup. The plugin requires Node.js ≥ 20 and DSH `>=0.2.0-rc.1 <0.3.0` (`engines.dsh`).

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
```

## Development

No runtime dependencies; the plugin uses only Node built-ins.

```sh
node --test tests/server.test.mjs
```

The test boots the plugin with a mock `sessionController`, checks the page, session listing, the SSE snapshot/delta/flash stream, and the read-only response. The page uses CSS `@media (orientation: landscape)` for layout and `matchMedia` for the footer's `竖屏`/`横屏` label.

### Layout

- `src/index.js` — Host plugin, HTTP/SSE listener, session listing and snapshot budget.
- `src/page.html` — light mobile page, active-task panes, orientation layout, flash.
- `cordis.patch.yml` — bundle layer that inserts the `lx-dsh-peek` row.
- `tests/server.test.mjs` — keyless mock test.

## License

MIT
