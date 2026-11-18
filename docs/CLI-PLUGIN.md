# `tmuxy plugin` reference

Generated from `--help` by `node bin/ci/cli-reference.mjs`; the other commands are in [CLI.md](CLI.md).

## `tmuxy plugin`

```text
Usage: tmuxy plugin <command> [args...]

Commands:
  install       Install by name from the index, from GitHub
                <owner/repo[/subdir][@ref]>, or link a local directory
                (--path DIR); with no argument, install exactly what
                plugins.json lists [--yes --sha COMMIT...]
  search        Search the plugin index [query]
  list          The installed plugins [--json]
  update        Move plugins to the latest commit of their ref [name]
  remove        Uninstall a plugin <name> [--purge] [--force: and its dependents]
  config        A plugin's settings <name> [key [value]] [--unset]
  path          Where a plugin is installed <name>
  action        Run an action on a pane <plugin>:<id> [--pane %id] [--wait]
                [-- args...]
  log           What a plugin ran, and how it exited <name> [-f]
  check         Validate a plugin directory [dir]
  new           Write a plugin to start from, tmuxy-<name>/ <name>
  <verb>        An installed plugin's own command [args...] (see 'list')

Plugin commands run unsandboxed as your user and can control every pane.
Install shows what a plugin can do and asks first; without a terminal it
needs --yes and a --sha <commit> for each commit it showed you (the plugin's
and each dependency's). docs/PLUGINS.md describes the
manifest (tmuxy-plugin.toml).
```

### `tmuxy plugin install`

```text
Install a plugin by its index name, from GitHub (owner/repo[/subdir][@ref]), or link a local directory (--path). With neither, install exactly what plugins.json lists

Usage: tmuxy-server plugin install [OPTIONS] [SOURCE]

Arguments:
  [SOURCE]

Options:
      --path <DIR>    Link a local directory: used in place, edits apply at once
      --yes           Do not ask (no terminal): needs a --sha for every commit fetched
      --sha <COMMIT>  A commit you reviewed, for --yes: once per commit the gate shows (the plugin's and each new dependency's), or comma-separated
  -j, --json          Answer in JSON
  -h, --help          Print help
```

### `tmuxy plugin search`

```text
Search the plugin index (repositories with the `tmuxy-plugin` topic)

Usage: tmuxy-server plugin search [OPTIONS] [QUERY]...

Arguments:
  [QUERY]...

Options:
  -j, --json  Answer in JSON
  -h, --help  Print help
```

### `tmuxy plugin list`

```text
The installed plugins

Usage: tmuxy-server plugin list [OPTIONS]

Options:
  -j, --json  Answer in JSON
  -h, --help  Print help
```

### `tmuxy plugin update`

```text
Move plugins to the latest commit of the ref they follow; asks again

Usage: tmuxy-server plugin update [OPTIONS] [NAME]

Arguments:
  [NAME]

Options:
      --yes
      --sha <COMMIT>
  -j, --json          Answer in JSON
  -h, --help          Print help
```

### `tmuxy plugin remove`

```text
Uninstall a plugin. Its config dir stays unless --purge

Usage: tmuxy-server plugin remove [OPTIONS] <NAME>

Arguments:
  <NAME>

Options:
      --purge
      --force  Also remove the plugins that depend on it
  -j, --json   Answer in JSON
  -h, --help   Print help
```

### `tmuxy plugin config`

```text
A plugin's settings: list them, read one, or set one (a secret with no value is read from the terminal)

Usage: tmuxy-server plugin config [OPTIONS] <NAME> [KEY] [VALUE]

Arguments:
  <NAME>
  [KEY]
  [VALUE]

Options:
      --unset  Put the setting back to its default
  -j, --json   Answer in JSON
  -h, --help   Print help
```

### `tmuxy plugin path`

```text
Where a plugin is installed (for a plugin that depends on it)

Usage: tmuxy-server plugin path [OPTIONS] <NAME>

Arguments:
  <NAME>

Options:
  -j, --json  Answer in JSON
  -h, --help  Print help
```

### `tmuxy plugin action`

```text
Run an action (<plugin>:<id>) on a pane, in the surface it declares

Usage: tmuxy-server plugin action [OPTIONS] <TARGET> [-- <ARGS>...]

Arguments:
  <TARGET>
  [ARGS]...  Extra arguments for the command, after `--`

Options:
      --pane <PANE>  The pane it is about (default: the caller's)
      --wait         Wait for the command to exit, and exit with its status
  -j, --json         Answer in JSON
  -h, --help         Print help
```

### `tmuxy plugin log`

```text
A plugin's log: what ran, and how it exited

Usage: tmuxy-server plugin log [OPTIONS] <NAME>

Arguments:
  <NAME>

Options:
  -f, --follow  Keep printing as it grows
  -j, --json    Answer in JSON
  -h, --help    Print help
```

### `tmuxy plugin check`

```text
Validate a plugin directory's manifest and commands

Usage: tmuxy-server plugin check [OPTIONS] [DIR]

Arguments:
  [DIR]  [default: .]

Options:
  -j, --json  Answer in JSON
  -h, --help  Print help
```

### `tmuxy plugin new`

```text
Write a new plugin, tmuxy-<name>/, to start from

Usage: tmuxy-server plugin new [OPTIONS] <NAME>

Arguments:
  <NAME>

Options:
  -j, --json  Answer in JSON
  -h, --help  Print help
```
