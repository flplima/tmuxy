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
            sha: None,
        },
    );
    assert!(no_sha.unwrap_err().to_string().contains("--sha"));
    let moved = gate::ask(
        &subject,
        &Answer {
            yes: true,
            sha: Some("f".repeat(40)),
        },
    );
    assert!(moved.unwrap_err().to_string().contains("nothing installed"));
    let ok = gate::ask(
        &subject,
        &Answer {
            yes: true,
            sha: Some(sha.into()),
        },
    );
    assert!(ok.unwrap());
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
