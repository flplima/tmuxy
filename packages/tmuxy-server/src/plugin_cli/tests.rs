use super::gate::{self, Answer, Subject};
use super::install::admissible;
use super::*;
use tmuxy_core::plugins::manifest::Manifest;
use tmuxy_core::plugins::RESERVED_VERBS;

const MANIFEST: &str = r#"
[plugin]
api = 1
name = "devtools"
version = "1.0.0"
requires = ["definitely-not-on-path-xyz"]

[[actions]]
id = "open"
title = "Open DevTools"
menu = "pane"
surface = "popup"
command = ["bin/open"]

[[cli]]
verb = "devtools"
command = ["bin/cli"]
"#;

fn parsed(text: &str) -> Manifest {
    tmuxy_core::plugins::manifest::parse(text).unwrap()
}

#[test]
fn the_gate_shows_every_capability_and_the_warning() {
    let m = parsed(MANIFEST);
    let sha = "0123456789abcdef0123456789abcdef01234567";
    let text = gate::render(
        &Subject {
            manifest: &m,
            source: "someone/tmuxy-devtools",
            sha: Some(sha),
            previous: None,
        },
        false,
    );
    assert!(text.contains("Install plugin devtools 1.0.0"), "{text}");
    assert!(text.contains(sha), "{text}");
    assert!(text.contains("run unsandboxed as your user"), "{text}");
    assert!(
        text.contains("open \"Open DevTools\" (popup, pane menu): bin/open"),
        "{text}"
    );
    assert!(text.contains("tmuxy plugin devtools: bin/cli"), "{text}");
    assert!(
        text.contains("definitely-not-on-path-xyz (not on PATH)"),
        "{text}"
    );
}

#[test]
fn an_update_lists_what_changes() {
    let old = parsed(MANIFEST);
    let new = parsed(
        &MANIFEST
            .replace("surface = \"popup\"", "surface = \"tab\"")
            .replace("verb = \"devtools\"", "verb = \"dt\""),
    );
    let changes = gate::diff(&old, &new);
    assert!(
        changes
            .iter()
            .any(|c| c.starts_with("~ action open") && c.contains("(tab")),
        "{changes:?}"
    );
    assert!(
        changes.contains(&"+ verb tmuxy plugin dt: bin/cli".to_string()),
        "{changes:?}"
    );
    assert!(
        changes.contains(&"- verb tmuxy plugin devtools".to_string()),
        "{changes:?}"
    );
    assert!(gate::diff(&old, &old).is_empty());
}

#[test]
fn yes_without_the_reviewed_commit_installs_nothing() {
    let m = parsed(MANIFEST);
    let sha = "0123456789abcdef0123456789abcdef01234567";
    let subject = Subject {
        manifest: &m,
        source: "o/r",
        sha: Some(sha),
        previous: None,
    };
    let no_sha = gate::ask(
        &subject,
        &Answer {
            yes: true,
            sha: Vec::new(),
        },
    );
    assert!(no_sha.unwrap_err().to_string().contains("--sha"));
    let moved = gate::ask(
        &subject,
        &Answer {
            yes: true,
            sha: vec!["f".repeat(40)],
        },
    );
    assert!(moved.unwrap_err().to_string().contains("nothing installed"));
    let ok = gate::ask(
        &subject,
        &Answer {
            yes: true,
            sha: vec![sha.into()],
        },
    );
    assert!(ok.unwrap());
}

#[test]
fn yes_names_every_commit_a_dependency_brings() {
    let app = parsed(MANIFEST);
    let lib = parsed(&MANIFEST.replace("devtools", "lib"));
    let (app_sha, lib_sha) = ("a".repeat(40), "b".repeat(40));
    let subjects = [
        Subject {
            manifest: &app,
            source: "o/app",
            sha: Some(&app_sha),
            previous: None,
        },
        Subject {
            manifest: &lib,
            source: "o/lib",
            sha: Some(&lib_sha),
            previous: None,
        },
    ];
    let yes = |sha: Vec<String>| gate::ask_all(&subjects, &Answer { yes: true, sha });
    let only_app = yes(vec![app_sha.clone()]).unwrap_err().to_string();
    assert!(only_app.contains(&lib_sha), "{only_app}");
    let none = yes(Vec::new()).unwrap_err().to_string();
    assert!(
        none.contains(&format!("--sha {app_sha} --sha {lib_sha}")),
        "{none}"
    );
    assert!(yes(vec![lib_sha.to_uppercase(), app_sha.clone()]).unwrap());

    // A linked plugin has no commit, but the repository it depends on does.
    let linked = [
        Subject {
            sha: None,
            ..subjects[0]
        },
        Subject { ..subjects[1] },
    ];
    let linked_yes = gate::ask_all(
        &linked,
        &Answer {
            yes: true,
            sha: Vec::new(),
        },
    );
    assert!(linked_yes.unwrap_err().to_string().contains(&lib_sha));
}

#[test]
fn an_update_lists_every_section_it_changes() {
    let old = parsed(&format!(
        "{MANIFEST}\n[[keys]]\nkey = \"M-d\"\naction = \"open\"\n"
    ));
    let new = parsed(
        &format!(
            r#"{MANIFEST}
[[keys]]
key = "M-e"
action = "open"

[[link_handlers]]
id = "gh"
match = "url"
hosts = ["github.com"]
action = "open"

[[settings]]
key = "token"
type = "string"
secret = true

[[themes]]
id = "dusk"
file = "dusk.css"
"#
        )
        .replace(
            "requires = [",
            "depends = [{ name = \"lib\", source = \"o/lib\" }]\nrequires = [",
        ),
    );
    let changes = gate::diff(&old, &new);
    for want in [
        "+ key prefix M-e -> open",
        "- key prefix M-d",
        "+ link gh: github.com -> open",
        "+ setting token (string, secret)",
        "+ theme dusk: dusk.css",
        "+ depends lib from o/lib",
    ] {
        assert!(changes.iter().any(|c| c == want), "{want}: {changes:?}");
    }
}

#[test]
fn an_action_is_named_plugin_colon_id() {
    assert_eq!(
        split_target("devtools:open").ok().unwrap(),
        ("devtools".to_string(), "open".to_string())
    );
    for bad in ["devtools", "devtools:", ":open", "dev tools:open", "a:b;c"] {
        let failure = split_target(bad).err().unwrap();
        assert_eq!(failure.code, 2, "{bad}");
    }
}

#[test]
fn a_built_in_or_taken_verb_and_the_user_name_are_refused() {
    let base = std::env::temp_dir().join(format!("tmuxy-plugin-cli-{}", std::process::id()));
    let root = base.join("p");
    std::fs::create_dir_all(root.join("bin")).unwrap();
    for f in ["bin/open", "bin/cli"] {
        std::fs::write(root.join(f), "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.join(f), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    let empty = Registry::default();
    let m = parsed(MANIFEST);
    assert!(admissible(&empty, &m, &root, None).is_ok());

    let builtin = parsed(&MANIFEST.replace("verb = \"devtools\"", "verb = \"install\""));
    let err = admissible(&empty, &builtin, &root, None).err().unwrap();
    assert!(
        err.message.contains("is a `tmuxy plugin` command"),
        "{}",
        err.message
    );

    let user = parsed(&MANIFEST.replace("name = \"devtools\"", "name = \"user\""));
    assert!(admissible(&empty, &user, &root, None).is_err());

    let future = parsed(&MANIFEST.replace("api = 1", "api = 1\nmin_tmuxy = \"99.0.0\""));
    let err = admissible(&empty, &future, &root, None).err().unwrap();
    assert!(
        err.message.contains("needs tmuxy 99.0.0"),
        "{}",
        err.message
    );

    let missing = parsed(&MANIFEST.replace("bin/open", "bin/absent"));
    assert!(admissible(&empty, &missing, &root, None).is_err());
    std::fs::remove_dir_all(base).unwrap();
}

/// A verb runs as `tmuxy plugin <verb>`, so it may not be one of `plugin`'s
/// own subcommands: every name clap knows is in `RESERVED_VERBS`.
#[test]
fn every_plugin_subcommand_is_reserved_from_verbs() {
    #[derive(clap::Parser)]
    struct Wrapper {
        #[command(flatten)]
        args: PluginArgs,
    }
    let command = <Wrapper as clap::CommandFactory>::command();
    let names: Vec<String> = command
        .get_subcommands()
        .map(|c| c.get_name().to_string())
        .collect();
    assert!(names.len() >= 10, "{names:?}");
    for name in names {
        assert!(
            RESERVED_VERBS.contains(&name.as_str()),
            "{name} is not reserved"
        );
    }
}

#[test]
fn any_other_word_is_a_verb_with_its_arguments() {
    #[derive(clap::Parser)]
    struct Wrapper {
        #[command(flatten)]
        args: PluginArgs,
    }
    let parsed =
        <Wrapper as clap::Parser>::try_parse_from(["x", "devtools", "attach", "--port", "9"])
            .unwrap();
    match parsed.args.verb {
        PluginCommand::Verb(words) => assert_eq!(words, ["devtools", "attach", "--port", "9"]),
        other => panic!("parsed as {other:?}"),
    }
}

/// A plugin key's binding runs `action … --trigger key`
/// (`plugins::keys::binding_command`): the command line must take it.
#[test]
fn a_key_binding_command_line_parses() {
    #[derive(clap::Parser)]
    struct Wrapper {
        #[command(flatten)]
        args: PluginArgs,
    }
    let line = tmuxy_core::plugins::keys::binding_command("p", "a");
    let words: Vec<&str> = line
        .split_whitespace()
        .skip_while(|w| *w != "action")
        .take_while(|w| !w.starts_with('>'))
        .map(|w| if w == "#{pane_id}" { "%1" } else { w })
        .collect();
    let mut argv = vec!["x"];
    argv.extend(words);
    let parsed = <Wrapper as clap::Parser>::try_parse_from(&argv);
    assert!(parsed.is_ok(), "{argv:?}: {:?}", parsed.err());
}
