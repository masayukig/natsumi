#!/bin/bash
# Installs the extension for this user and registers natsumi:// for the login callback.
# A newly installed extension is seen by GNOME Shell on Wayland only after logging in again;
# then enable it with: gnome-extensions enable natsumi@masayukig.github.io
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
uuid=natsumi@masayukig.github.io
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

gnome-extensions pack --force --extra-source=avatar.js --extra-source=session.js \
  --schema=schemas/org.gnome.shell.extensions.natsumi.gschema.xml -o "$out" "$here/$uuid"
gnome-extensions install --force "$out/$uuid.shell-extension.zip"

apps=${XDG_DATA_HOME:-$HOME/.local/share}/applications
mkdir -p "$apps"
cp "$here/natsumi-url-handler.desktop" "$apps/"
# Without this the handler is the default but not "registered" for the type, and the portal finds no app.
update-desktop-database "$apps"
xdg-mime default natsumi-url-handler.desktop x-scheme-handler/natsumi
echo "installed $uuid; natsumi:// -> $(xdg-mime query default x-scheme-handler/natsumi)"
