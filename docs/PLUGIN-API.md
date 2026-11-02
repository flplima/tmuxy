# The plugin API

What a plugin may rely on from tmuxy. Everything else is internal and may
change in any release.

tmuxy is under active development and breaks its own internals freely
(AGENTS.md); this surface is the exception. **Removing or changing anything
listed here needs `api = 2`** in the manifests that use it. **Adding to it**
(a new variable, a new verb, a new JSON field) is allowed in any release, and
a plugin that needs the addition says so with `min_tmuxy`.

## The manifest

`[plugin] api = 1`, and the schema in [PLUGINS.md](PLUGINS.md#the-manifest).
A tmuxy refuses a manifest whose `api` it does not implement, and one whose
`min_tmuxy` is newer than itself.

## The environment of a command

Every action command gets:

| Variable | Value |
| --- | --- |
| `TMUXY_PLUGIN_NAME` | The plugin's name. |
| `TMUXY_PLUGIN_DIR` | The plugin's directory, which is also the working directory of an action command. Read-only by convention: an update replaces it. |
| `TMUXY_PLUGIN_CONFIG_DIR` | `<config_dir>/plugins/<name>/`, owner-only: settings and credentials, kept across updates. |
| `TMUXY_PLUGIN_STATE_DIR` | `<state_dir>/plugins/<name>.state/`, owner-only: caches. tmuxy writes the plugin's `log` here. |
| `TMUXY_TARGET_PANE` | The pane the action is about (`%N`), which is not the pane the command runs in. |
| `TMUXY_PLUGIN_CONTEXT_JSON` | The context, below. |
| `TMUXY_SELECTION_FILE` | Only for a selection action: a file (owner-only) holding the selected text, byte for byte; removed when the command exits. |

A `[[cli]]` verb's command (`tmuxy plugin <verb>`) gets the same variables (no selection), runs in
the caller's working directory, and has `trigger: "cli"` in its context.

As every process in a tmuxy pane, a command also has `TMUX`, `TMUX_PANE` (the
pane it runs in) and the `tmuxy` CLI.

### `TMUXY_PLUGIN_CONTEXT_JSON`

```json
{
  "plugin": "chrome-devtools",
  "action": "open",
  "trigger": "menu",
  "pane": { "id": "%3", "cwd": "/home/me/project", "command": "zsh" },
  "tab": "@2",
  "session": "main",
  "selection_file": "/…/plugins/.run/….selection",
  "settings": {}
}
```

| Field | Meaning |
| --- | --- |
| `trigger` | `menu` (a menu item), `action` (`tmuxy plugin action`), `cli` (`tmuxy plugin <verb>`). Later releases add `key` and `link`. |
| `action` | The action's id; absent for a verb. |
| `pane` | The target pane, as tmux described it when the action opened. |
| `selection_file` | Present only when there is a selection. |
| `settings` | Always `{}` for now; the settings schema fills it in a later release. |

A plugin must ignore fields it does not know.

## The CLI

A plugin may call any `tmuxy` verb a user may; these are the ones whose
`--json` shapes and exit codes are part of this API:

| Verb | Use |
| --- | --- |
| `tmuxy pane list --json` | The panes of a tab. |
| `tmuxy pane capture <pane> [--json]` | What a pane shows. |
| `tmuxy pane send -t <pane> <keys…>` | Type into a pane (asks the user there first). |
| `tmuxy pane run [--wait] -- <cmd…>` | Run a command in a new pane. |
| `tmuxy pane float [cmd…]`, `tmuxy tab create [--json]` | Open a float or a tab. |
| `tmuxy open <file.md\|file.html>` | Show a document or a page in a pane (read-only, sandboxed). |
| `tmuxy plugin action <plugin>:<id> [--pane %N] [--wait] [-- args…]` | Run an action, this plugin's or another's. |

Exit codes, for every verb: `0` ok, `1` failed (or declined), `2` bad command
line, `3` target not found, `4` no tmux server, `130` interrupted; `--wait`
exits with the command's own status. A failure under `--json` is one object,
`{"ok":false,"error":"…","code":N}`.

## The tmux options

A plugin may read the `@tmuxy-*` options documented in
[TMUX-TAGS.md](TMUX-TAGS.md) and set `@tmuxy-pane-state` and `@tmuxy-label` on
its own pane (through the CLI: `tmuxy pane state`, `tmuxy pane run --label`).
`@tmuxy-plugins` and `@tmuxy-plugins-rev` are tmuxy's own; a plugin never
writes them.

## Held by

`tests/cli/cli-plugin.test.js` (dispatch, the reserved nouns),
`packages/tmuxy-server/tests/plugin_install.rs` (install, the gate, the
lockfile), `tmuxy_core::plugins` unit tests (manifest, context, tokens) and
`tests/17-plugins.test.js` (the menus, every surface, the selection file).
