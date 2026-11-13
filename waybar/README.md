# AI Quota for Waybar

A port of the AI Quota GNOME Shell extension to [Waybar](https://github.com/Alexays/Waybar),
for Hyprland, Sway and other wlroots desktops. It shows the same thing: one fill-level
gauge per quota window for Claude Code, Grok Build and Codex, coloured by how close you
are to the limit, with a tooltip that gives the percentage used, the time until reset and
the exact reset time, and a desktop notification when a quota crosses the warning or
critical threshold.

```
C ▁▃  G ▂▁
```

Each provider is its own Waybar module, so each gets its own tooltip:

- **Bar:** the provider's letter, then one gauge per window. A gauge fills from the bottom
  and is coloured green, amber or red (Tokyo Night palette) at the warn and critical
  thresholds. A faded gauge means the reading is stale. A lone `·` or `!` means there is
  no reading yet, or there was an error with nothing to fall back on.
- **Tooltip:** every window (including ones hidden from the bar), each with its percentage,
  a bar, "Resets in 4h 48m" and the reset time, then where the reading came from and how
  old it is.
- **Right-click:** refresh now.
- **Notifications:** sent with `notify-send` (mako, dunst, swaync and others) using the same
  rising-edge policy as the extension: each threshold fires once and re-arms only after
  usage drops back below it.

## How it works

It is a single Python 3 script, standard library only, that reuses the extension's data
sources and rules unchanged:

| Provider | Live source | Offline fallback |
| --- | --- | --- |
| Claude Code | `GET api.anthropic.com/api/oauth/usage` with the token in `~/.claude/.credentials.json` | `cachedUsageUtilization` in `~/.claude.json` |
| Grok Build | `GET cli-chat-proxy.grok.com/v1/billing?format=credits` with the token in `~/.grok/auth.json` | the last billing record in `~/.grok/logs/unified.jsonl` |
| Codex (unverified) | `GET chatgpt.com/backend-api/wham/usage` with the token in `~/.codex/auth.json` | none |

The same polling rules apply as in the extension: at least 180 seconds between polls
(300 by default) with jitter, and geometric backoff on network errors. An expired or
rejected token stops polling until the vendor CLI rewrites its credential file. Tokens
are never refreshed, logged or stored. Quotas that drop out of a reading (xAI omits
zero-usage products) are carried forward at 0% for up to a week so the gauges don't
reshuffle.

Waybar runs one copy of each module per monitor. The copies share a lock in
`~/.local/state/aiquota-waybar/`, so only one copy per provider polls and sends
notifications, and the others draw from the state file it writes. That file holds
readings only, with mode 0600. On first run it adopts the GNOME extension's last
readings and notification state from `~/.local/state/aiquota/state.json`, so switching
desktops doesn't announce a threshold you have already seen.

## Install

```sh
bash waybar/install.sh --restart
```

This:

1. Copies the script to `~/.config/waybar/scripts/aiquota-waybar`.
2. Writes `~/.config/aiquota-waybar/config.json` from the GNOME extension's GSettings if
   it can find the schema (otherwise from the defaults). An existing file is left alone.
3. Backs up `~/.config/waybar/config`, `config.jsonc` and `style.css` (as
   `*.bak-aiquota-<timestamp>`), then adds a `custom/aiquota-<provider>` module to the
   start of `modules-right` for each enabled provider, plus a marked CSS block.
4. With `--restart`, restarts Waybar.

The installer only edits a Waybar config that is plain JSON. If yours has comments, it
says so, and you can paste the entries from `modules.jsonc` yourself. Running it again is
safe. `bash waybar/install.sh --uninstall` removes the modules, the CSS block and the script,
and leaves your settings and state.

## Settings

`~/.config/aiquota-waybar/config.json` uses the extension's key names:

| Key | Default | Meaning |
| --- | --- | --- |
| `poll-interval` | 300 | seconds between polls (floor 180) |
| `providers-enabled` | `["claude","grok","codex"]` | providers to show |
| `hidden-quotas` | `[]` | quota ids to keep out of the bar (still listed in the tooltip) |
| `auto-hide-inactive` | true | hide windows that are inactive, at 0% and have no reset |
| `show-window-labels` | false | add a small `5h` / `wk` tag after each gauge |
| `show-pool-totals` | false | also show Grok's combined Credits pool as a gauge |
| `warn-threshold` / `critical-threshold` | 75 / 90 | colour bands and notifications |
| `notifications-enabled` | true | send threshold notifications |
| `color-normal` / `color-warn` / `color-critical` | `#9ece6a` / `#e0af68` / `#f7768e` | gauge colours |
| `color-track` / `color-dim` | `#2f334d` / `#565f89` | gauge background and muted text |

Settings are read when the module starts. Restart Waybar after changing them.

## Command line

```sh
aiquota-waybar --provider claude          # what Waybar runs: one JSON line per change
aiquota-waybar --provider grok --once     # print one reading and exit
aiquota-waybar --refresh claude           # ask the running module to poll now
aiquota-waybar --import-gnome-settings ~/projects/aiquota/schemas
```

## Tests

```sh
python3 -m unittest discover -s waybar/tests
```

The parser, formatting, continuity and notification tests are ported from `test/parsers.js`
and `test/notify.js` and use the same fixtures in `test/fixtures`. Tests for rendering,
polling, persistence, the GSettings import and the one-poller-per-provider lock come on top.
