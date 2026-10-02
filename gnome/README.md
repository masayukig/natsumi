# natsumi for the GNOME desktop

A GNOME Shell extension (GNOME 50, Wayland) that puts natsumi on the desktop the way the Mac app does:
the avatar stays above every window and can be dragged around. Her latest unread reply shows in a balloon,
and her notices show as cards. Clicking her, or pressing Ctrl+Alt+N, opens a box to talk to her.

The face icon's menu has a switch "ペットを出す" (setting `hidden`). Turn it off and she and her balloon and notice
column are hidden; talking to her again (the menu's "話しかける" or the shortcut) shows her.
When she has not been used for a while she fades: if `fade-seconds` seconds (0 = off, default 300) pass without the
pointer on her, a word to her or a server event, she and the column turn translucent
(「しばらく使わないと半透明にする」). `fade-opacity` (percent, 10–100, default 40) sets how opaque she is while faded.

It is an extension rather than an app because on GNOME's Wayland an app cannot keep itself on top or choose
where it stands. Only the shell can.

## Install

```sh
gnome/install.sh
```

The script installs the extension and registers `natsumi://` so the GitHub login can come back to it.
GNOME Shell on Wayland notices a newly installed extension only after you log in again. After that:

```sh
gnome-extensions enable natsumi@masayukig.github.io
gnome-extensions prefs natsumi@masayukig.github.io   # set the server, e.g. https://natsumi.example.com
```

Then choose "GitHub でログイン" from the face icon in the top bar. The token is kept in the GNOME keyring.

## How it talks to the server

It follows [the client contract](../docs/client-contract.md) as one more device, like the Mac app.

- **Login.** It uses PKCE with the fixed callback `natsumi://oauth/callback`. The handler
  `natsumi-url-handler.desktop` passes the URL to the extension over D-Bus (`io.github.masayukig.Natsumi.OpenUri`),
  and the extension accepts it only if the state matches the login it started.
- **Connection.** It connects over WSS with a Bearer token. It sends `session.sync` and resumes from the stream position.
  The connection is pinged every 20 s. When it drops, it reconnects after `min(30, 2^n)` s.
  It does not use push; like the Mac app, it stays connected.
- **Avatar.** It fetches `/v1/avatar`, checks each file against its sha256, and keeps the files in `~/.cache/natsumi-gnome`.
  At rest she holds still and plays her idle row once every 20–30 s. Other expressions loop.

## Developing

- `gjs -m gnome/test.js` checks the parts that run outside the shell.
- A bug in an extension takes the whole session down, and on Wayland that closes every app.
  Try changes in a nested shell first: `dbus-run-session gnome-shell --devkit --wayland`
  (the `mutter-devkit` package).
  - Set `XDG_CONFIG_HOME` and `XDG_DATA_HOME` **before** `dbus-run-session`. dconf-service starts on that bus and
    takes the bus's environment, so setting them inside writes to the real session's settings.
  - Give the nested shell an IBus input source too, or input-method paths go untested.
- Make actors once and only show or hide them. Destroying a focused `St.Entry` while IBus was composing crashed
  gnome-shell.
