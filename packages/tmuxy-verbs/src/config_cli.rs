//! The config verbs whose work is a file tmuxy-core owns live here, so the
//! shell CLI keeps no copy of the files' names or formats.

use tmuxy_core::paths::{Layout, FILES};

use crate::cli_json::{self, Answer, EXIT_FAILED};

#[derive(clap::Args, Debug)]
pub struct ConfigArgs {
    #[command(subcommand)]
    verb: ConfigVerb,
    /// Answer in JSON.
    #[arg(long, global = true)]
    json: bool,
}

#[derive(clap::Subcommand, Debug)]
enum ConfigVerb {
    /// Every file tmuxy reads or writes: owner, location, safe to edit, safe
    /// to symlink.
    Paths,
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
    let answer = Answer::new(args.json);
    match args.verb {
        ConfigVerb::Paths if args.json => println!("{}", layout.report()),
        ConfigVerb::Paths => print!("{}", paths_text(&layout)),
        ConfigVerb::Reload => {
            if let Err(e) = tmuxy_core::session::request_reload(&layout) {
                answer.exit(EXIT_FAILED, &format!("config reload: {e}"));
            }
            let conf = layout.config.join("tmuxy.conf");
            answer.done(
                &[("file", cli_json::string(&conf.display().to_string()))],
                &format!(
                    "Reloading {} — the app re-applies it within a second.",
                    conf.display()
                ),
            );
        }
        ConfigVerb::UseTmuxConf { value: None } => {
            let on = tmuxy_core::session::read_managed_state()
                .use_tmux_conf
                .unwrap_or(false);
            answer.done(
                &[("useTmuxConf", on.to_string())],
                if on {
                    "use-tmux-conf: on  (~/.tmux.conf is sourced, then tmuxy.essentials.conf on top)"
                } else {
                    "use-tmux-conf: off (tmuxy uses its own config only)"
                },
            );
        }
        ConfigVerb::UseTmuxConf { value: Some(value) } => {
            let on = value == "on";
            let changes = tmuxy_core::session::ManagedState {
                use_tmux_conf: Some(on),
                ..Default::default()
            };
            if let Err(e) = tmuxy_core::session::write_managed_state(changes) {
                answer.exit(EXIT_FAILED, &format!("config use-tmux-conf: {e}"));
            }
            let said = if on {
                "use-tmux-conf: on — tmuxy will source ~/.tmux.conf, then re-apply its essentials."
            } else {
                "use-tmux-conf: off — tmuxy will use its own config only."
            };
            answer.done(
                &[("useTmuxConf", on.to_string())],
                &format!(
                    "{said}\nRestart tmuxy for this to take effect (the config chain is read when it connects)."
                ),
            );
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

    /// The JSON the CLI prints for `config paths --json`: the dirs, and every
    /// file with its owner and whether it is the user's to edit and to link.
    #[test]
    fn the_report_names_every_file_and_only_the_users_are_theirs() {
        let layout = Layout {
            config: "/c".into(),
            data: "/d".into(),
            state: "/s".into(),
            home: "/h".into(),
        };
        let report = layout.report();
        assert_eq!(report["dirs"]["state"], "/s");
        let files = report["files"].as_array().unwrap_or(&Vec::new()).clone();
        assert_eq!(files.len(), FILES.len());
        for file in &files {
            let users = file["owner"] == "user";
            assert_eq!(file["safeToSymlink"], users, "{file}");
        }
        assert!(files
            .iter()
            .any(|f| f["path"] == "/c/tmuxy.conf" && f["safeToEdit"] == true));
    }
}
