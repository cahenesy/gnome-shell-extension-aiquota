#!/usr/bin/env bash
# Install (or remove) the AI Quota Waybar module for the current user.
#
#   ./install.sh               install the script, settings, modules and CSS
#   ./install.sh --restart     ...and restart Waybar afterwards
#   ./install.sh --uninstall   remove the modules, CSS and script (settings and
#                              state are left in place)
#
# Never needs root. Backs up the Waybar config and style.css before editing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WAYBAR_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/waybar"
SCRIPT="$WAYBAR_DIR/scripts/aiquota-waybar"
SETTINGS="${XDG_CONFIG_HOME:-$HOME/.config}/aiquota-waybar/config.json"
STAMP="$(date +%Y%m%d-%H%M%S)"

mode=install
restart=no
for arg in "$@"; do
  case "$arg" in
    --uninstall) mode=uninstall ;;
    --restart) restart=yes ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
mkdir -p "$WAYBAR_DIR"

backup() {
  # Never overwrite an earlier backup from the same second (a quick re-run).
  if [ -f "$1" ] && [ ! -e "$1.bak-aiquota-$STAMP" ]; then
    cp -p "$1" "$1.bak-aiquota-$STAMP" && echo "backed up $1 -> $1.bak-aiquota-$STAMP"
  fi
  return 0
}

if [ "$mode" = install ]; then
  install -D -m 0755 "$HERE/aiquota_waybar.py" "$SCRIPT"
  echo "installed $SCRIPT"

  if [ ! -f "$SETTINGS" ]; then
    mkdir -p "$(dirname "$SETTINGS")"
    # Carry over the GNOME extension's preferences when its schema can be found.
    schemadir=""
    for d in "$HERE/../schemas" "$HOME/.local/share/gnome-shell/extensions/aiquota@heartofgoldventures.com/schemas"; do
      [ -f "$d/gschemas.compiled" ] && { schemadir="$d"; break; }
    done
    python3 "$SCRIPT" --import-gnome-settings "$schemadir" > "$SETTINGS"
    echo "wrote $SETTINGS${schemadir:+ (imported from GNOME settings)}"
  else
    echo "kept existing $SETTINGS"
  fi
fi

for config in "$WAYBAR_DIR/config" "$WAYBAR_DIR/config.jsonc"; do
  [ -f "$config" ] || continue
  backup "$config"
  python3 - "$config" "$SETTINGS" "$mode" <<'PY'
import json, sys
path, settings_path, mode = sys.argv[1:4]
try:
    with open(path, encoding='utf-8') as f:
        config = json.load(f)
except ValueError:
    print(f'{path} is not plain JSON (comments?); add the modules from waybar/modules.jsonc by hand')
    sys.exit(0)
bars = config if isinstance(config, list) else [config]
try:
    with open(settings_path, encoding='utf-8') as f:
        enabled = json.load(f).get('providers-enabled', ['claude', 'grok', 'codex'])
except (OSError, ValueError):
    enabled = ['claude', 'grok', 'codex']
names = [f'custom/aiquota-{p}' for p in ('claude', 'grok', 'codex') if p in enabled]
script = '$HOME/.config/waybar/scripts/aiquota-waybar'
for bar in bars:
    right = bar.setdefault('modules-right', [])
    right[:] = [m for m in right if not str(m).startswith('custom/aiquota-')]
    for key in [k for k in bar if k.startswith('custom/aiquota-')]:
        del bar[key]
    if mode == 'install':
        right[0:0] = names
        for name in names:
            provider = name.rsplit('-', 1)[1]
            bar[name] = {
                'exec': f'{script} --provider {provider}',
                'return-type': 'json',
                'tooltip': True,
                'restart-interval': 30,
                'on-click-right': f'{script} --refresh {provider}',
            }
with open(path + '.tmp', 'w', encoding='utf-8') as f:
    json.dump(config, f, indent=2, ensure_ascii=False)
    f.write('\n')
import os
os.replace(path + '.tmp', path)
print(f"{'updated' if mode == 'install' else 'cleaned'} {path}: {', '.join(names) if mode == 'install' else 'modules removed'}")
PY
done

css="$WAYBAR_DIR/style.css"
touch "$css"
backup "$css"
python3 - "$css" "$HERE/style.css" "$mode" <<'PY'
import re, sys
path, block_path, mode = sys.argv[1:4]
with open(path, encoding='utf-8') as f:
    css = f.read()
css = re.sub(r'\n*/\* aiquota-waybar:begin.*?aiquota-waybar:end \*/\n?', '\n', css, flags=re.S)
if mode == 'install':
    with open(block_path, encoding='utf-8') as f:
        css = css.rstrip('\n') + '\n\n' + f.read()
with open(path, 'w', encoding='utf-8') as f:
    f.write(css)
print(f"{'styled' if mode == 'install' else 'unstyled'} {path}")
PY

if [ "$mode" = uninstall ]; then
  rm -f "$SCRIPT"
  echo "removed $SCRIPT (settings in $SETTINGS and state in ~/.local/state/aiquota-waybar kept)"
fi

if [ "$restart" = yes ]; then
  pkill -x waybar || true
  sleep 0.5
  if command -v hyprctl >/dev/null && [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]; then
    hyprctl dispatch exec waybar >/dev/null
  else
    setsid -f waybar >/dev/null 2>&1
  fi
  echo "restarted waybar"
else
  echo "restart Waybar to load it: pkill waybar; hyprctl dispatch exec waybar"
fi
