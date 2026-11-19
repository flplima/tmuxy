Install tmuxy on macOS or Linux, check that it starts, and learn where it keeps its files.

## What you need

- **tmux 3.2 or newer.** Check with `tmux -V`. The app tells you at launch if tmux is missing or too old.
- **macOS or Linux.** There is no Windows build.
- **FUSE on Linux**, if you run the AppImage (`libfuse2` on Debian and Ubuntu).

Homebrew and the `.deb` install tmux for you.

## Install on macOS

```bash
# The desktop app, signed and notarized by Apple
brew install --cask flplima/tap/tmuxy
```

You can also download the DMG from the [Releases page](https://github.com/flplima/tmuxy/releases). It opens without a Gatekeeper warning.

## Install on Linux

```bash
# Homebrew casks are macOS only, so this is the formula (no --cask)
brew install flplima/tap/tmuxy
```

The formula installs the AppImage as the `tmuxy` command. It needs FUSE at runtime:

```bash
# Debian and Ubuntu
sudo apt install libfuse2
```

Prefer a native package? Download the `.deb` or the `.AppImage` from the [Releases page](https://github.com/flplima/tmuxy/releases).

## Start it

```bash
# Opens the desktop app (from an app launcher works too)
tmuxy
```

On Linux, the first run adds tmuxy to your applications menu. After that you can launch it without a terminal. Set `TMUXY_NO_DESKTOP_ENTRY=1` to skip that.

The desktop app also writes a small `tmuxy` command into `~/.local/bin` on every launch. Put that folder on your `PATH` to use the CLI from any shell.

No desktop? Run the web server instead. See [[Desktop or Web]].

## Update

tmuxy never checks for updates. Neither the app nor the server asks anywhere whether a newer version exists. Update the way you installed:

```bash
brew upgrade
```

Or download the new version from the Releases page. Homebrew has its own analytics, and `brew analytics off` turns them off.

## Where your files live

```bash
# Every file tmuxy reads or writes, who owns it, and whether you can edit it
tmuxy config paths
```

| Folder | Default                                                               | What it holds                                                                    |
| ------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| config | `~/.config/tmuxy`                                                     | Your files, like `tmuxy.conf`. Safe to edit and to symlink from a dotfiles repo. |
| data   | `~/.local/share/tmuxy`                                                | tmuxy's own files, rewritten on every launch. Do not edit.                       |
| state  | `~/.local/state/tmuxy` (macOS: `~/Library/Application Support/tmuxy`) | This machine's state, like saved servers. Never shared between machines.         |

tmuxy writes the config folder once, on the first run, and never again.

## Remove it

Remove tmuxy the way you installed it. Three things it may have set up are yours to undo:

```bash
# Stop the web server and remove its service file, if you ran `tmuxy server install`
# (on main, not in a release yet)
tmuxy server uninstall

# Take tmuxy out of your coding agents' config, if you ran `tmuxy agent install`
tmuxy agent uninstall

# Remove a plugin (its config folder stays unless you add --purge)
tmuxy plugin remove <name>
```

The three folders above stay on disk until you delete them.

## See also

- [[Quick Start]]
- [[Desktop or Web]]
- [[Troubleshooting]]
