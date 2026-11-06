//! `tmuxy-server config …`: the config verbs whose work is a file tmuxy-core
//! owns, so the CLI's `tmuxy config` can call them instead of keeping its own
//! copy of the file's format.
//!
//! - `paths [--json]`: every file tmuxy keeps, from the one table of them
//!   (`tmuxy_core::paths::FILES`), resolved on this machine.
//! - `reload`: touch the marker every running app watches.
//! - `use-tmux-conf [on|off]`: read or set the menu-state choice to source
//!   `~/.tmux.conf`, through the same reader and writer the app uses.

use tmuxy_core::paths::{Layout, FILES};

#[derive(clap::Args, Debug)]
pub struct ConfigArgs {
    #[command(subcommand)]
    verb: ConfigVerb,
}

#[derive(clap::Subcommand, Debug)]
enum ConfigVerb {
    /// Every file tmuxy reads or writes: owner, location, safe to edit, safe
    /// to symlink.
    Paths {
        #[arg(long)]
        json: bool,
    },
    /// Ask every running app to re-source the config chain.
    Reload,
    /// Print whether `~/.tmux.conf` is sourced, or set it.
    UseTmuxConf {
        #[arg(value_parser = ["on", "off"])]
        value: Option<String>,
    },
}

pub fn run(args: ConfigArgs) {
    let layout = Layout::current();
    match args.verb {
        ConfigVerb::Paths { json } => {
            if json {
                println!("{}", layout.report());
            } else {
                print!("{}", paths_text(&layout));
            }
        }
        ConfigVerb::Reload => {
            if let Err(e) = tmuxy_core::session::request_reload(&layout) {
                eprintln!("tmuxy config reload: {e}");
                std::process::exit(1);
            }
        }
        ConfigVerb::UseTmuxConf { value: None } => {
            let on = tmuxy_core::session::read_managed_state()
                .use_tmux_conf
                .unwrap_or(false);
            println!("{}", if on { "on" } else { "off" });
        }
        ConfigVerb::UseTmuxConf { value: Some(value) } => {
            let changes = tmuxy_core::session::ManagedState {
                use_tmux_conf: Some(value == "on"),
                ..Default::default()
            };
            if let Err(e) = tmuxy_core::session::write_managed_state(changes) {
                eprintln!("tmuxy config use-tmux-conf: {e}");
                std::process::exit(1);
            }
        }
    }
}

fn paths_text(layout: &Layout) -> String {
    let yn = |b: bool| if b { "yes" } else { "no" };
    let mut out = format!(
        "config  {}\n        yours: safe to edit, safe to symlink; tmuxy writes it only on the first run\n\
         data    {}\n        tmuxy's: mirrored on every launch, read-only; read or copy, never edit\n\
         state   {}\n        this machine's: not config, never shared between machines\n\n",
        layout.config.display(),
        layout.data.display(),
        layout.state.display(),
    );
    out.push_str(&format!(
        "{:<6}  {:<5}  {:<4}  {:<7}  {}\n",
        "OWNER", "EDIT", "LINK", "EXISTS", "PATH"
    ));
    for file in FILES {
        let path = layout.path(file);
        let exists = std::fs::symlink_metadata(&path).is_ok();
        let shown = if file.name.ends_with('/') {
            format!("{}/", path.display())
        } else {
            path.display().to_string()
        };
        out.push_str(&format!(
            "{:<6}  {:<5}  {:<4}  {:<7}  {}\n",
            file.dir.owner(),
            yn(file.safe_to_edit),
            yn(file.safe_to_symlink()),
            yn(exists),
            shown
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_text_lists_every_file_under_its_dir() {
        let layout = Layout {
            config: "/c".into(),
            data: "/d".into(),
            state: "/s".into(),
            home: "/h".into(),
        };
        let text = paths_text(&layout);
        assert!(text.starts_with("config  /c\n"));
        assert!(text.contains("user    yes    yes   no       /c/tmuxy.conf\n"));
        assert!(text.contains("tmuxy   no     no    no       /s/sessions/\n"));
        assert_eq!(text.lines().count(), 8 + FILES.len());
    }
}
