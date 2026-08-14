#!/usr/bin/env bash
# Install AI Quota into the current user's GNOME Shell extensions directory.
#
#   ./install.sh          symlink this checkout (best for development)
#   ./install.sh --copy   copy the files instead
#
# GNOME Shell must be restarted for a new install to appear. On Wayland that
# means logging out and back in, or testing in a nested shell:
#
#   dbus-run-session -- gnome-shell --devkit
#
# (--nested was removed in GNOME 50; --devkit replaces it.)

set -euo pipefail

UUID="aiquota@heartofgoldventures.com"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

MODE="link"
[[ "${1:-}" == "--copy" ]] && MODE="copy"

echo "Compiling GSettings schema…"
glib-compile-schemas "${SOURCE_DIR}/schemas"

if [[ -e "${TARGET_DIR}" || -L "${TARGET_DIR}" ]]; then
    echo "Removing existing ${TARGET_DIR}"
    rm -rf "${TARGET_DIR}"
fi

mkdir -p "$(dirname "${TARGET_DIR}")"

if [[ "${MODE}" == "link" ]]; then
    ln -s "${SOURCE_DIR}" "${TARGET_DIR}"
    echo "Linked ${TARGET_DIR} -> ${SOURCE_DIR}"
else
    mkdir -p "${TARGET_DIR}"
    cp -r "${SOURCE_DIR}"/{metadata.json,extension.js,prefs.js,stylesheet.css,lib,providers,schemas} \
        "${TARGET_DIR}/"
    echo "Copied into ${TARGET_DIR}"
fi

echo
echo "Running parser tests…"
gjs -m "${SOURCE_DIR}/test/parsers.js"

echo
echo "Next:"
echo "  gnome-extensions enable ${UUID}"
echo "  # then log out and back in (Wayland cannot restart the shell in place)"
echo "  journalctl -f -o cat /usr/bin/gnome-shell   # to watch for errors"
