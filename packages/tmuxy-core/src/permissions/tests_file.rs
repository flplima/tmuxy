//! The file itself: what is not rules, and how it is read from disk.

use super::tests::keys;
use super::*;

/// A file that cannot be read as rules is an error with its reason: it is
/// never read as fewer rules than the user wrote.
#[test]
fn a_file_that_is_not_rules_is_refused_with_the_reason() {
    for (text, reason) in [
        ("", "not JSON"),
        ("{", "not JSON"),
        ("[]", "the file must hold one JSON object"),
        ("null", "the file must hold one JSON object"),
        (r#"{"caller": {}}"#, "unknown key `caller`"),
        (
            r#"{"callers": {"*": {"deny": ["Send(rm *)"]}}, "callers": {}}"#,
            "the key `callers` is written twice",
        ),
        (
            r#"{"callers": {"a": {"deny": ["Send(rm *)"], "deny": []}}}"#,
            "the key `deny` is written twice",
        ),
        (
            r#"{"callers": {"a": {}, "a": {}}}"#,
            "the key `a` is written twice",
        ),
        (
            r#"{"callers": {"a": {"deny": [null]}}}"#,
            "must be a list of strings",
        ),
        (
            r#"{"callers": {"a": {"deny": [["Send(x)"]]}}}"#,
            "must be a list of strings",
        ),
        ("true", "the file must hold one JSON object"),
        ("3.5", "the file must hold one JSON object"),
        (r#"{"callers": []}"#, "`callers` must be an object"),
        (r#"{"callers": {"a": []}}"#, "callers.a must be an object"),
        (
            r#"{"callers": {"a": {"alow": []}}}"#,
            "callers.a: unknown key `alow`",
        ),
        (
            r#"{"callers": {"a": {"deny": "Send(rm *)"}}}"#,
            "callers.a.deny must be a list of strings",
        ),
        (
            r#"{"callers": {"a": {"deny": [1]}}}"#,
            "callers.a.deny must be a list of strings",
        ),
        (
            r#"{"callers": {"": {"deny": []}}}"#,
            "a caller's name is empty",
        ),
        (
            r#"{"callers": {"a": {"deny": ["rm *"]}}}"#,
            "is not of the form Send(<pattern>)",
        ),
        (
            r#"{"callers": {"a": {"deny": ["Send(rm *"]}}}"#,
            "is not of the form Send(<pattern>)",
        ),
        (
            r#"{"callers": {"a": {"deny": ["Send()"]}}}"#,
            "has an empty pattern",
        ),
        (
            r#"{"callers": {"a": {"deny": ["send(rm *)"]}}}"#,
            "only Send(...) rules are understood",
        ),
        (
            r#"{"callers": {"a": {"deny": ["destroy(any)"]}}}"#,
            "only Send(...) rules are understood",
        ),
        (
            r#"{"callers": {"a": {"allow": ["read(tab)"]}}}"#,
            "only Send(...) rules are understood",
        ),
        (r#"{"shells": "zsh"}"#, "`shells` must be a list of strings"),
        (
            r#"{"shells": ["zsh", " "]}"#,
            "`shells` holds an empty name",
        ),
    ] {
        let error = Permissions::parse(text).expect_err(text);
        assert!(error.contains(reason), "{text}: {error}");
    }
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "tmuxy-permissions-test-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// No file is the one case that leaves tmuxy as it is without the feature.
/// Every other way of not reading rules denies, and says why.
#[test]
fn a_missing_file_says_nothing_and_an_unreadable_one_denies() {
    let dir = scratch("load");
    let path = dir.join("permissions.json");
    let send = Send {
        callers: &["anyone"],
        // No section binds this caller: a readable file has nothing to
        // say. An unreadable one still denies.
        program: "vim",
        keys: &keys(&["i"]),
        paste: false,
    };

    assert_eq!(Loaded::read(&path), Loaded::Missing);
    assert_eq!(Loaded::read(&path).check_send(send), Decision::NoOpinion);

    std::fs::write(&path, r#"{"callers": {"a": {"deny": ["Send(rm *)"]}}}"#).unwrap();
    assert!(matches!(Loaded::read(&path), Loaded::Rules(_)));
    assert_eq!(Loaded::read(&path).check_send(send), Decision::NoOpinion);

    std::fs::write(&path, r#"{"callers": {"a": {"deny": ["rm *"]}}}"#).unwrap();
    let decision = Loaded::read(&path).check_send(send);
    assert_eq!(decision.word(), "deny");
    assert!(
        decision.reason().contains("cannot be read as rules"),
        "{decision:?}"
    );
    assert!(
        decision
            .reason()
            .contains("is not of the form Send(<pattern>)"),
        "{decision:?}"
    );

    // Bytes that are not text, a directory in the file's place, a link to
    // nothing and a file too large to be rules: each denies.
    std::fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
    assert_eq!(Loaded::read(&path).check_send(send).word(), "deny");
    std::fs::write(&path, vec![b' '; (MAX_FILE_BYTES + 1) as usize]).unwrap();
    assert!(matches!(Loaded::read(&path), Loaded::Malformed(why) if why.contains("larger than")));
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(
        matches!(Loaded::read(&path), Loaded::Malformed(why) if why.contains("not a regular file"))
    );
    std::fs::remove_dir(&path).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.join("nowhere.json"), &path).unwrap();
        assert!(matches!(Loaded::read(&path), Loaded::Malformed(why) if why.contains("link")));
        // A link to a real file is how a dotfiles repo keeps it: read through.
        std::fs::remove_file(&path).unwrap();
        std::fs::write(dir.join("real.json"), "{}").unwrap();
        std::os::unix::fs::symlink(dir.join("real.json"), &path).unwrap();
        assert!(matches!(Loaded::read(&path), Loaded::Rules(_)));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// The file is read when it is asked, every time: an edit holds from the
/// next send on, with nothing to reload.
#[test]
fn an_edit_holds_from_the_next_read() {
    let dir = scratch("edit");
    let path = dir.join("permissions.json");
    let typed = keys(&["rm x", "Enter"]);
    let send = Send {
        callers: &["a"],
        program: "sh",
        keys: &typed,
        paste: false,
    };
    std::fs::write(&path, r#"{"callers": {"a": {"allow": ["Send(rm *)"]}}}"#).unwrap();
    assert_eq!(Loaded::read(&path).check_send(send).word(), "allow");
    std::fs::write(&path, r#"{"callers": {"a": {"deny": ["Send(rm *)"]}}}"#).unwrap();
    assert_eq!(Loaded::read(&path).check_send(send).word(), "deny");
    let _ = std::fs::remove_dir_all(&dir);
}
