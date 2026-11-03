//! `tmuxy plugin new <name>`: a working plugin to start from.

use std::path::{Path, PathBuf};

use super::{is_valid_name, PluginError, Result, TMUXY_VERSION};

fn manifest(name: &str) -> String {
    format!(
        r#"# The plugin manifest: docs/PLUGINS.md in the tmuxy repository lists every key.
[plugin]
api = 1
min_tmuxy = "{TMUXY_VERSION}"
name = "{name}"
version = "0.1.0"
description = "Says hello from a popup"
platforms = ["linux", "macos"]

[[actions]]
id = "hello"
title = "Say hello"
menu = "pane"                          # "app" | "pane" | "selection", or leave it out
surface = "popup"                      # "split" | "tab" | "float" | "popup" | "zoomed"
size = {{ width = "60%", height = "50%" }}
command = ["bin/hello"]                # an argv inside this directory; never run by a shell
"#
    )
}

const HELLO: &str = r#"#!/usr/bin/env bash
# What a plugin command gets: the environment below, and its own directory as
# the working directory. TMUXY_PLUGIN_CONTEXT_JSON has the pane it is about.
set -euo pipefail
echo "Hello from $TMUXY_PLUGIN_NAME"
echo
echo "target pane:  $TMUXY_TARGET_PANE"
echo "plugin dir:   $TMUXY_PLUGIN_DIR"
echo "config dir:   $TMUXY_PLUGIN_CONFIG_DIR"
echo "context:      $TMUXY_PLUGIN_CONTEXT_JSON"
if [ -n "${TMUXY_SELECTION_FILE:-}" ]; then
  echo "selection:    $(head -c 200 "$TMUXY_SELECTION_FILE")"
fi
echo
read -r -p "Press Enter to close. "
"#;

fn readme(name: &str) -> String {
    format!(
        r#"# tmuxy-{name}

A [tmuxy](https://tmuxy.sh) plugin.

## Try it while you write it

```sh
tmuxy plugin install --path .      # a live link: edits apply without reinstalling
tmuxy plugin action {name}:hello   # or the pane menu's Plugins submenu
tmuxy plugin log {name}            # what ran, and how it exited
tmuxy plugin check .               # validate the manifest
```

## Publish it

Push it to GitHub and add the `tmuxy-plugin` topic to the repository. Anyone
can then install it with:

```sh
tmuxy plugin install <owner>/tmuxy-{name}
```

## A compiled plugin

A manifest's `command` is a file in the plugin, so a compiled plugin ships a
small launcher that picks its binary by platform:

```sh
#!/bin/sh
exec "$(dirname "$0")/../dist/{name}-$(uname -s)-$(uname -m)" "$@"
```
"#
    )
}

/// Write `tmuxy-<name>/` under `parent` and return its path.
pub fn create(parent: &Path, name: &str) -> Result<PathBuf> {
    if !is_valid_name(name) {
        return Err(PluginError::Invalid(format!(
            "{name:?}: a plugin name is lowercase letters, digits and '-'"
        )));
    }
    let dir = parent.join(format!("tmuxy-{name}"));
    if dir.exists() {
        return Err(PluginError::Invalid(format!(
            "{} already exists",
            dir.display()
        )));
    }
    let write = |rel: &str, text: &str| -> Result<()> {
        let path = dir.join(rel);
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p)
                .map_err(|e| PluginError::io(format!("creating {}", p.display()), e))?;
        }
        std::fs::write(&path, text)
            .map_err(|e| PluginError::io(format!("writing {}", path.display()), e))
    };
    write(super::MANIFEST_FILE, &manifest(name))?;
    write("bin/hello", HELLO)?;
    write("README.md", &readme(name))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let hello = dir.join("bin/hello");
        std::fs::set_permissions(&hello, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| PluginError::io(format!("chmod {}", hello.display()), e))?;
    }
    Ok(dir)
}
