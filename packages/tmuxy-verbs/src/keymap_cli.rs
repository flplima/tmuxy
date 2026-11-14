//! `tmuxy keymap`: every key the config binds and the file and line it comes
//! from (`tmuxy_core::session::keymap`), with the bindings the user's files
//! replaced and the keys that cannot work as written.

use std::path::Path;

use tmuxy_core::paths::Layout;
use tmuxy_core::session::keymap::{keymap, Binding, Keymap, Layer, Shadow, Source};

use crate::cli_json::{Answer, EXIT_FAILED};

#[derive(clap::Args, Debug)]
pub struct KeymapArgs {
    /// Only this key table (`prefix`, `root`, `pane`, `tab`, …).
    #[arg(long)]
    table: Option<String>,
    /// Only this key, as tmux names it (`t`, `C-a`, `M-Left`).
    key: Option<String>,
    /// Answer in JSON.
    #[arg(long)]
    json: bool,
}

pub fn run(args: KeymapArgs) {
    let layout = Layout::current();
    let answer = Answer::new(args.json);
    let mut map = keymap(&layout);
    // What tmux binds by itself is only known to a running server. A read,
    // on the socket tmuxy is on; none running is no error. `-N`: never start
    // one to answer, since a server tmux starts reads the user's
    // `~/.tmux.conf`, which may run anything (tmux 3.2 has the flag).
    let live = tmuxy_core::session::tmux_command()
        .args(["-N", "list-keys"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned());
    let mut defaults_unknown = false;
    if let Some(listing) = &live {
        let defaults = tmux_defaults();
        defaults_unknown = defaults.is_none();
        let defaults = defaults.unwrap_or_default();
        map.add_unattributed(tmuxy_core::list_keys::rows(listing).map(|row| {
            let own = (
                row.table.to_string(),
                row.key.to_string(),
                row.command.clone(),
            );
            Binding {
                table: row.table.to_string(),
                key: row.key_name().to_string(),
                command: row.command.clone(),
                repeat: row.repeat,
                source: if defaults.contains(&own) {
                    Source::tmux()
                } else {
                    Source::running()
                },
            }
        }));
    }
    if let Some(table) = &args.table {
        map.only_table(table);
    }
    if let Some(key) = &args.key {
        map.bindings.retain(|binding| &binding.key == key);
        map.shadows.retain(|shadow| &shadow.lost.key == key);
    }
    if map.bindings.is_empty() && map.shadows.is_empty() {
        let what = match (&args.table, &args.key) {
            (Some(table), Some(key)) => format!("{key} in the {table} table"),
            (Some(table), None) => format!("the {table} table"),
            (None, Some(key)) => key.clone(),
            (None, None) => "anything".to_string(),
        };
        answer.exit(EXIT_FAILED, &format!("keymap: nothing binds {what}"));
    }
    if args.json {
        let shadows: Vec<&Shadow> = map.notable_shadows().collect();
        answer.done(
            &[
                ("prefix", json(&map.prefix)),
                ("bindings", json(&map.bindings)),
                ("shadowed", json(&shadows)),
                ("warnings", json(&map.warnings)),
                ("serverRead", live.is_some().to_string()),
                ("tmuxDefaultsRead", (!defaults_unknown).to_string()),
            ],
            "",
        );
        return;
    }
    print!("{}", text(&map, &layout.home, live.is_some()));
    if defaults_unknown {
        println!(
            "\ntmux's own bindings could not be read, so every binding that is in no file is listed as set while running."
        );
    }
}

/// tmux's own bindings, as a server started with no config lists them:
/// what the running server holds that is in no file and not here was bound
/// while it ran. The server is a throwaway, on a socket in a folder of its
/// own that only this user can read, and gone with its one command. `None`
/// when it could not be asked.
fn tmux_defaults() -> Option<std::collections::HashSet<(String, String, String)>> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    let dir = std::env::temp_dir().join(format!("tmuxy-keymap-{}", std::process::id()));
    builder.create(&dir).ok()?;
    let socket = dir.join("s").to_string_lossy().into_owned();
    let listed = tmuxy_core::session::local_tmux_on(&socket)
        .env_remove("TMUX")
        .args(["-f", "/dev/null", "start-server", ";", "list-keys"])
        .output();
    let _ = tmuxy_core::session::local_tmux_on(&socket)
        .args(["-N", "kill-server"])
        .output();
    let _ = std::fs::remove_dir_all(&dir);
    let listed = listed.ok().filter(|out| out.status.success())?;
    let text = String::from_utf8_lossy(&listed.stdout);
    Some(
        tmuxy_core::list_keys::rows(&text)
            .map(|row| (row.table.to_string(), row.key.to_string(), row.command))
            .collect(),
    )
}

fn json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

/// Where a binding comes from, short enough for a column: tmuxy's own files
/// by name (they live in its data dir, which is not the user's), the user's
/// with `~` for their home.
fn from(source: &Source, home: &Path) -> String {
    let line = source.line.map(|l| format!(":{l}")).unwrap_or_default();
    match (&source.file, source.layer) {
        (_, Layer::Tmux | Layer::Running) | (None, _) => source.layer.label().to_string(),
        (Some(file), layer) if !layer.is_users() => format!(
            "{}{line}",
            file.file_name().unwrap_or_default().to_string_lossy()
        ),
        (Some(file), _) => match file.strip_prefix(home) {
            Ok(rest) => format!("~/{}{line}", rest.display()),
            Err(_) => format!("{}{line}", file.display()),
        },
    }
}

fn row(binding: &Binding, home: &Path) -> [String; 4] {
    let key = if binding.repeat {
        format!("{} (-r)", binding.key)
    } else {
        binding.key.clone()
    };
    [
        binding.table.clone(),
        key,
        from(&binding.source, home),
        binding.command.clone(),
    ]
}

fn text(map: &Keymap, home: &Path, server_read: bool) -> String {
    let mut out = String::new();
    match &map.prefix {
        Some(prefix) => out.push_str(&format!(
            "Prefix: {}  ({})\n\n",
            prefix.key,
            from(&prefix.source, home)
        )),
        None => out.push_str("Prefix: C-b  (tmux's own)\n\n"),
    }
    let mut rows = vec![[
        "TABLE".to_string(),
        "KEY".to_string(),
        "FROM".to_string(),
        "COMMAND".to_string(),
    ]];
    rows.extend(map.bindings.iter().map(|binding| row(binding, home)));
    let width = |column: usize| rows.iter().map(|r| r[column].chars().count()).max();
    let widths: Vec<usize> = (0..3).map(|c| width(c).unwrap_or(0)).collect();
    for r in &rows {
        out.push_str(&format!(
            "{:w0$}  {:w1$}  {:w2$}  {}\n",
            r[0],
            r[1],
            r[2],
            r[3],
            w0 = widths[0],
            w1 = widths[1],
            w2 = widths[2]
        ));
    }
    let shadows: Vec<&Shadow> = map.notable_shadows().collect();
    if !shadows.is_empty() {
        out.push_str("\nReplaced by a later line:\n");
        for shadow in shadows {
            out.push_str(&format!(
                "  {} {}  {} ({})  {} at {}\n",
                shadow.lost.table,
                shadow.lost.key,
                shadow.lost.command,
                from(&shadow.lost.source, home),
                if shadow.rebound { "rebound" } else { "unbound" },
                from(&shadow.by, home),
            ));
        }
    }
    if !map.warnings.is_empty() {
        out.push_str("\nWarnings:\n");
        // The paths in a warning are written in full (they are for `--json`
        // too); the table above shows the user's home as `~`, and so does this.
        let home = format!("{}/", home.display());
        for warning in &map.warnings {
            out.push_str(&format!("  {}\n", warning.replace(&home, "~/")));
        }
    }
    if !server_read {
        out.push_str(
            "\nNo tmux server answered: the bindings tmux makes by itself are not listed.\n",
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn a_source_is_shown_short() {
        let home = Path::new("/h");
        let at = |layer, file: &str| Source {
            layer,
            file: Some(PathBuf::from(file)),
            line: Some(4),
        };
        assert_eq!(
            from(
                &at(Layer::Defaults, "/h/.local/share/tmuxy/tmuxy.defaults.conf"),
                home
            ),
            "tmuxy.defaults.conf:4"
        );
        assert_eq!(
            from(&at(Layer::UserConf, "/h/.config/tmuxy/tmuxy.conf"), home),
            "~/.config/tmuxy/tmuxy.conf:4"
        );
        assert_eq!(
            from(&at(Layer::UserConf, "/elsewhere/keys.conf"), home),
            "/elsewhere/keys.conf:4"
        );
        let tmux = Source {
            layer: Layer::Tmux,
            file: None,
            line: None,
        };
        assert_eq!(from(&tmux, home), "tmux");
    }
}
