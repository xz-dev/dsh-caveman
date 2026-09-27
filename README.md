# dsh-caveman

One cordis plugin for DeepSeek Harness that ports four Pi setup pieces to DSH + dsh-TUI:

| Source (Pi) | What it does |
|---|---|
| [jonjonrankin/pi-caveman](https://github.com/jonjonrankin/pi-caveman) | `/caveman` terse-mode levels, animated campfire status, system-prompt injection, `caveman.json` persisted defaults |
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (`pi-extension/` + `hooks/`) | `/ponytail` lazy-dev modes, instruction injection filtered by mode, status dot, `/ponytail-*` skill aliases, whole-message `stop ponytail`/`normal mode` deactivation |
| `~/.pi/agent/extensions/rtk.ts` | Rewrites `bash -c` tool commands through `rtk rewrite` (>= 0.23.0) for token savings, fail-open |
| [xz-dev/pi-abort-command](https://github.com/xz-dev/pi-abort-command) | `/abort` cancels the current agent operation |

See **BEHAVIOR.md** for the item-by-item parity checklist (trigger → Pi evidence → DSH seam → status).

## Install

```bash
dsh plugin --profile tui add file:/abs/path/dsh-caveman-0.1.0.tgz --ignore-scripts
```

or a git dependency in the profile `package.json`. The package carries
`dsh.bundle.patch` (`cordis.patch.yml`), which inserts the `dsh-caveman` row with
defaults matching the user's Pi config — no extra profile edits needed.

### Grants

The `stop ponytail` / `normal mode` input interceptor needs one grant in
`~/.dsh-tui/extension-grants.json` (dsh-TUI decision points are default-deny):

```json
{
  "grants": {
    "dsh-caveman": [
      { "name": "session.input.intercept", "scope": "tui/input" }
    ]
  }
}
```

Without the grant, deactivation still works via the `agent/inbox/inserted`
fallback (the line is delivered to the model — same as Pi).

## Config

| Patch config key | Env override | Pi-equivalent file | Default |
|---|---|---|---|
| `ponytailDefaultMode` | `PONYTAIL_DEFAULT_MODE` | `$XDG_CONFIG_HOME/ponytail/config.json` `defaultMode` | `full` |
| `ponytailHideStatus` | `PONYTAIL_HIDE_STATUS` | same file `hideStatus` | `false` |
| `ponytailQuietStartup` | `PONYTAIL_QUIET_STARTUP` | same file `quietStartup` | `false` |
| `cavemanDefaultLevel` | — | `$PI_CODING_AGENT_DIR/caveman.json` `defaultLevel` | `full` |
| `cavemanShowStatus` | — | same file `showStatus` | `true` |
| `rtkEnabled` | `RTK_DISABLED=1` disables | — | `true` |

Existing Pi config files are read first (resolution order preserved verbatim),
so a user migrating keeps their saved defaults; `config.json` keys here are the
fallback layer.

## Commands

```
/caveman [off|lite|full|ultra|wenyan-lite|wenyan|wenyan-ultra|micro|stop|quit|config]
/ponytail [off|lite|full|ultra|status|default <mode>]
/ponytail-review|audit|gain|debt|help   → queue "/skill:ponytail-*" user message
/abort
```

Ponytail skills must be present in `$DSH_HOME/skills/ponytail*` (they are, in the
daily profile); the instruction injector reads `ponytail/SKILL.md` and falls back
to the built-in text when missing.

## Test

```bash
node --test test/*.test.mjs   # 21 unit tests, pure fakes
```

## License

MIT. Ported fragments keep upstream attribution (pi-caveman © jonjonrankin,
ponytail © DietrichGebert, pi-abort-command © Xiangzhe).
