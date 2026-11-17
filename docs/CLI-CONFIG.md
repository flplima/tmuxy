# `tmuxy config` reference

Generated from `--help` by `node bin/ci/cli-reference.mjs`; the other commands are in [CLI.md](CLI.md).

## `tmuxy config`

```text
Usage: tmuxy config <setting> [value]

Settings:
  reload                   Re-apply the config to the running app: the whole
                           chain (defaults, your tmuxy.conf, essentials) is
                           re-sourced and every @tmuxy-* option re-read.
                           Refused while tmux cannot parse your config: the
                           running one is kept.
  check [file] [--json]    What is wrong with your config, with file and line,
                           found without applying it: a line tmux cannot
                           parse, an option it does not have, a source-file
                           whose file is not there. Reads your tmuxy.conf
                           (and ~/.tmux.conf when it is sourced) and what they
                           source, or the file you name. Exit 1 when there is
                           anything.
  use-tmux-conf [on|off]   Source your own ~/.tmux.conf on tmuxy's socket.
                           With no value, prints the current setting.
  init                     Write the starter tmuxy.conf into the config dir.
                           Refuses to overwrite one that exists.
  paths [--json]           Every file tmuxy reads or writes: its owner, where
                           it is, and whether it is safe to edit and to symlink.
  doctor [--fix] [--json]  The source-file lines of your tmuxy.conf whose file
                           is not there (tmux stops reading the config at the
                           first one): list them and exit 1, or with --fix
                           comment each out in place, keeping a timestamped
                           backup beside the file.
  permissions [--caller NAME] [--into PROGRAM] [-- KEYS...]
                           What permissions.json says: with no keys, whether
                           it reads as rules; with keys, what typing them into
                           another pane would get (allow, ask, deny or none).
                           Nothing is sent. Exits 1 for a file that is not
                           rules and for a send it denies.

Your files live in the config dir (~/.config/tmuxy), which tmuxy never writes
after the first run, so it is safe to symlink from a dotfiles repo. tmuxy's own
files are in its data dir, this machine's state in its state dir.

With `use-tmux-conf on`, tmuxy sources ~/.tmux.conf after its defaults and
before your tmuxy.conf, then re-applies tmuxy.essentials.conf on top: your
prefix, status line and plugins win over tmuxy's defaults, and the settings
tmuxy needs to function are restored afterwards whatever your config did to
them. It takes effect the next time tmuxy connects to its tmux server.
```
