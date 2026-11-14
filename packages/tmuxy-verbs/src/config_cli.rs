//! The config verbs: their work is a file tmuxy-core owns, so the shell CLI
//! keeps no copy of the files' names or formats.

use tmuxy_core::paths::{Layout, FILES};
use tmuxy_core::permissions::{self, Decision, Loaded};

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
    /// Ask every running app to re-source the config chain. Refused, with
    /// the line, while tmux cannot parse your config: the running one is
    /// kept.
    Reload,
    /// What is wrong with your config, found without applying it: a line
    /// tmux cannot parse, an option it does not have, a `source-file` whose
    /// file is not there. Exit 1 when there is anything.
    Check {
        /// A config file to check, with what it sources (default: your
        /// tmuxy.conf, and ~/.tmux.conf when it is sourced).
        file: Option<std::path::PathBuf>,
    },
    /// Write the starter tmuxy.conf into the config dir; refuses to
    /// overwrite one.
    Init,
    /// Print whether `~/.tmux.conf` is sourced, or set it.
    UseTmuxConf {
        #[arg(value_parser = ["on", "off"])]
        value: Option<String>,
    },
    /// The `source-file` lines of tmuxy.conf whose file is not there: list
    /// them (exit 1 when there are any), or comment them out in place.
    Doctor {
        /// Comment each dead line out, keeping a timestamped backup beside
        /// the file.
        #[arg(long)]
        fix: bool,
    },
    /// What permissions.json says. With no keys: whether it reads as rules.
    /// With keys: what typing them into another pane would get (allow, ask,
    /// deny, or none when no rule binds the send), without sending anything.
    Permissions {
        /// A name the caller answers to (`claude`; repeat it for more).
        #[arg(long)]
        caller: Vec<String>,
        /// The program in front in the pane typed into.
        #[arg(long, default_value = "sh")]
        into: String,
        /// The text would be pasted, not typed.
        #[arg(long)]
        paste: bool,
        /// The keys, as `tmuxy pane send` takes them.
        #[arg(last = true)]
        keys: Vec<String>,
    },
}

pub fn run(args: ConfigArgs) {
    let layout = Layout::current();
    let answer = Answer::new(args.json);
    match args.verb {
        ConfigVerb::Permissions {
            caller,
            into,
            paste,
            keys,
        } => check_permissions(&answer, &caller, &into, paste, &keys),
        ConfigVerb::Paths if args.json => println!("{}", layout.report()),
        ConfigVerb::Paths => print!("{}", paths_text(&layout)),
        ConfigVerb::Check { file } => std::process::exit(check(&layout, &answer, file.as_deref())),
        ConfigVerb::Reload => reload(&layout, &answer),
        ConfigVerb::Init => match tmuxy_core::session::init_user_conf(&layout) {
            Ok(path) => {
                let path = path.display().to_string();
                answer.done(
                    &[("file", cli_json::string(&path))],
                    &format!("Wrote {path}"),
                );
            }
            Err(message) => answer.exit(EXIT_FAILED, &message),
        },
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
        ConfigVerb::Doctor { fix } => std::process::exit(doctor(&layout, &answer, fix)),
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

/// `tmuxy config reload`: refused, with the line, while tmux cannot parse
/// the config; else the marker every running app watches is touched.
fn reload(layout: &Layout, answer: &Answer) {
    let blockers = tmuxy_core::session::reload_blockers(layout);
    if !blockers.is_empty() {
        let code = answer.fail_with(
            EXIT_FAILED,
            &format!(
                "config reload: not reloaded, the running config is kept: {} problem(s)",
                blockers.len()
            ),
            &[("problems", problems_json(&blockers))],
        );
        if !answer.is_json() {
            eprintln!("{}", problems_text(&blockers));
        }
        std::process::exit(code);
    }
    if let Err(e) = tmuxy_core::session::request_reload(layout) {
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

fn problems_json(problems: &[tmuxy_core::session::ConfigProblem]) -> String {
    let items: Vec<String> = problems
        .iter()
        .map(|p| {
            format!(
                r#"{{"file":{},"line":{},"kind":{},"message":{}}}"#,
                cli_json::string(&p.file.display().to_string()),
                p.line.map_or("null".to_string(), |line| line.to_string()),
                cli_json::string(p.kind.as_str()),
                cli_json::string(&p.message)
            )
        })
        .collect();
    format!("[{}]", items.join(","))
}

fn problems_text(problems: &[tmuxy_core::session::ConfigProblem]) -> String {
    problems
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n")
}

/// `tmuxy config check [file]`, and its exit code: 0 for a config with
/// nothing wrong (or none at all), 1 while there is a problem in it, or when
/// tmux could not be asked.
fn check(layout: &Layout, answer: &Answer, file: Option<&std::path::Path>) -> i32 {
    if let Some(file) = file.filter(|file| !file.is_file()) {
        return answer.fail(
            EXIT_FAILED,
            &format!("config check: {} is not a file", file.display()),
        );
    }
    // A relative path is the caller's; the report names files in full.
    let file = file.map(|file| std::fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf()));
    let report = match tmuxy_core::session::check_config(layout, file.as_deref()) {
        Ok(report) => report,
        Err(e) => return answer.fail(EXIT_FAILED, &format!("config check: {e}")),
    };
    let files = format!(
        "[{}]",
        report
            .files
            .iter()
            .map(|f| cli_json::string(&f.display().to_string()))
            .collect::<Vec<_>>()
            .join(",")
    );
    if report.problems.is_empty() {
        let text = match report.files.as_slice() {
            [] => format!(
                "No config to check: {} does not exist",
                layout.user_conf().display()
            ),
            files => format!(
                "{}\nNothing wrong in {} file(s)",
                files
                    .iter()
                    .map(|f| f.display().to_string())
                    .collect::<Vec<_>>()
                    .join("\n"),
                files.len()
            ),
        };
        answer.done(&[("files", files), ("problems", "[]".to_string())], &text);
        return 0;
    }
    answer.fail_with(
        EXIT_FAILED,
        &format!("{} problem(s) in the config", report.problems.len()),
        &[
            ("files", files),
            ("problems", problems_json(&report.problems)),
        ],
    );
    if !answer.is_json() {
        eprintln!("{}", problems_text(&report.problems));
    }
    EXIT_FAILED
}

/// `tmuxy config doctor [--fix]`, and its exit code: 0 for a clean file (or
/// one just made clean), 1 while a dead `source-file` line is in it.
fn doctor(layout: &Layout, answer: &Answer, fix: bool) -> i32 {
    use tmuxy_core::session::{dead_sources, DeadSource, DOCTOR_HINT};
    let file = layout.user_conf().display().to_string();
    let json_list = |dead: &[DeadSource]| {
        let items: Vec<String> = dead
            .iter()
            .map(|d| {
                format!(
                    r#"{{"file":{},"line":{},"written":{},"target":{}}}"#,
                    cli_json::string(&d.file.display().to_string()),
                    d.line,
                    cli_json::string(&d.written),
                    cli_json::string(&d.target.display().to_string())
                )
            })
            .collect();
        format!("[{}]", items.join(","))
    };
    let listed = |dead: &[DeadSource]| {
        dead.iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    };
    if fix {
        return match tmuxy_core::session::fix(layout) {
            Ok(fixed) if fixed.fixed.is_empty() => {
                answer.done(
                    &[
                        ("file", cli_json::string(&file)),
                        ("fixed", "[]".to_string()),
                    ],
                    &format!("{file}: nothing to fix"),
                );
                0
            }
            Ok(fixed) => {
                let backup = fixed.backup.map(|b| b.display().to_string());
                answer.done(
                    &[
                        ("file", cli_json::string(&file)),
                        (
                            "backup",
                            backup
                                .as_deref()
                                .map_or("null".to_string(), cli_json::string),
                        ),
                        ("fixed", json_list(&fixed.fixed)),
                    ],
                    &format!(
                        "Commented out {} line(s) in {file}:\n{}\nThe file as it was: {}",
                        fixed.fixed.len(),
                        listed(&fixed.fixed),
                        backup.as_deref().unwrap_or("(no backup)")
                    ),
                );
                0
            }
            Err(e) => answer.fail(EXIT_FAILED, &format!("config doctor: {file}: {e}")),
        };
    }
    let dead = dead_sources(layout);
    if dead.is_empty() {
        answer.done(
            &[
                ("file", cli_json::string(&file)),
                ("dead", "[]".to_string()),
            ],
            &format!("{file}: every source-file target exists"),
        );
        return 0;
    }
    answer.fail_with(
        EXIT_FAILED,
        &format!("{} dead source-file line(s) in {file}", dead.len()),
        &[("dead", json_list(&dead))],
    );
    if !answer.is_json() {
        eprintln!("{}\n{DOCTOR_HINT}", listed(&dead));
    }
    EXIT_FAILED
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

/// What the file holds, for `tmuxy config permissions` with no keys.
fn report_file(answer: &Answer, path: &std::path::Path, file: String, loaded: &Loaded) {
    match loaded {
        Loaded::Missing => answer.done(
            &[("file", file), ("exists", "false".into())],
            &format!(
                "No {}: a send into another pane asks, as it does without the file.",
                path.display()
            ),
        ),
        Loaded::Rules(rules) => {
            let (count, _) = rules.counts();
            let callers = rules.callers();
            let everyone = callers.contains(&permissions::ANY_CALLER);
            // A caller is named by what it says it is, so only `*` holds
            // for one that gives another name.
            let note = match (callers.is_empty(), everyone) {
                (true, _) => "It names no caller, so it binds nobody.".to_string(),
                (false, true) => format!("Sections: {}.", callers.join(", ")),
                (false, false) => format!(
                    "Sections: {}. There is no `*` section: a caller under another name is not bound, so a rule that must hold for everyone goes under `*`.",
                    callers.join(", ")
                ),
            };
            let names: Vec<String> = callers.iter().map(|c| cli_json::string(c)).collect();
            answer.done(
                &[
                    ("file", file),
                    ("exists", "true".into()),
                    ("rules", count.to_string()),
                    ("callers", format!("[{}]", names.join(","))),
                    ("bindsEveryone", everyone.to_string()),
                ],
                &format!("{}: {count} rule(s). {note}", path.display()),
            );
        }
        Loaded::Malformed(why) => answer.exit(
            EXIT_FAILED,
            &format!(
                "{} cannot be read as rules: {why}. Every send into another pane is refused until it is fixed or removed.",
                path.display()
            ),
        ),
    }
}

/// `tmuxy config permissions`: the file read as a send would read it, and
/// what it says. Exit 1 for a file that is not rules and for a send it
/// denies, so a script can tell either from the rest.
fn check_permissions(
    answer: &Answer,
    callers: &[String],
    into: &str,
    paste: bool,
    keys: &[String],
) {
    // The file a send would read: the tmux server's, when one is running.
    let path = crate::permissions_file::path();
    let file = cli_json::string(&path.display().to_string());
    let loaded = Loaded::read(&path);
    if keys.is_empty() {
        return report_file(answer, &path, file, &loaded);
    }
    let callers: Vec<&str> = callers.iter().map(String::as_str).collect();
    let decision = loaded.check_send(permissions::Send {
        callers: &callers,
        program: into,
        keys,
        paste,
    });
    let fields = [
        ("file", file),
        ("decision", cli_json::string(decision.word())),
        ("reason", cli_json::string(decision.reason())),
    ];
    if let Decision::Deny(_) = decision {
        std::process::exit(answer.fail_with(
            EXIT_FAILED,
            &format!("deny: {}", decision.reason()),
            &fields,
        ));
    }
    let note = match decision {
        Decision::Allow(_) => " (reported only: an allow rule skips no question in this version)",
        _ => "",
    };
    answer.done(
        &fields,
        &format!("{}: {}{note}", decision.word(), decision.reason()),
    );
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
