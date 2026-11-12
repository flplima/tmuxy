use super::*;
use crate::session::{managed_state_commands, profile_commands, ManagedState};

/// A profiles dir of the test's own in the temp dir: never the user's.
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tmuxy-profiles-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn nord() -> Profile {
    Profile {
        theme: Some("nord".into()),
        theme_mode: Some("light".into()),
        cursor_blink: Some(false),
        ..Profile::default()
    }
}

/// A user who never touches profiles gets exactly what they got before:
/// the same attach commands, and a state file with nothing new in it.
#[test]
fn the_default_profile_changes_nothing() {
    let dir = scratch("default");
    let state = ManagedState {
        theme: Some("dracula".into()),
        cursor_blink: Some(true),
        ..ManagedState::default()
    };
    assert!(profile_commands(&state, "work", &dir, &[]).is_empty());
    assert_eq!(
        managed_state_commands(&state, &[]),
        [
            "set-option -g @tmuxy-theme 'dracula'",
            "set-option -g @tmuxy-cursor-blink 'on'"
        ]
    );
    let saved = serde_json::to_string(&state).unwrap();
    assert!(!saved.contains("session_profiles"), "{saved}");
    // A session named on the default profile changes nothing either.
    let mut named = state.clone();
    named
        .session_profiles
        .insert("work".into(), DEFAULT_PROFILE.into());
    assert!(profile_commands(&named, "work", &dir, &[]).is_empty());
    assert_eq!(list(&dir), [DEFAULT_PROFILE]);
    assert_eq!(load(&dir, DEFAULT_PROFILE).unwrap(), Profile::default());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_session_with_a_profile_gets_its_values_over_the_global_ones() {
    let dir = scratch("session");
    save(&dir, "Reading", &nord()).unwrap();
    let mut state = ManagedState::default();
    state
        .session_profiles
        .insert("work".into(), "Reading".into());
    assert_eq!(
        profile_commands(&state, "work", &dir, &[]),
        [
            "set-option -t 'work' @tmuxy-profile 'Reading'",
            "set-option -t 'work' @tmuxy-theme 'nord'",
            "set-option -t 'work' @tmuxy-theme-mode 'light'",
            "set-option -t 'work' @tmuxy-cursor-blink 'off'",
        ]
    );
    // Another session keeps the global settings.
    assert!(profile_commands(&state, "other", &dir, &[]).is_empty());
    // An option the user's tmuxy.conf pins stays pinned.
    let pinned = profile_commands(&state, "work", &dir, &["@tmuxy-theme"]);
    assert!(
        !pinned.iter().any(|c| c.contains("@tmuxy-theme ")),
        "{pinned:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_profile_that_cannot_be_read_leaves_the_session_alone() {
    let dir = scratch("broken");
    std::fs::write(dir.join("Broken.json"), "{ not json").unwrap();
    let mut state = ManagedState::default();
    state
        .session_profiles
        .insert("work".into(), "Broken".into());
    assert!(profile_commands(&state, "work", &dir, &[]).is_empty());
    state.session_profiles.insert("work".into(), "Gone".into());
    assert!(profile_commands(&state, "work", &dir, &[]).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn profiles_are_made_copied_renamed_and_deleted_and_the_default_one_is_not_a_file() {
    let dir = scratch("store");
    create(&dir, "Reading", DEFAULT_PROFILE).unwrap();
    assert_eq!(load(&dir, "Reading").unwrap(), Profile::default());
    save(&dir, "Reading", &nord()).unwrap();
    create(&dir, "Reading copy", "Reading").unwrap();
    assert_eq!(load(&dir, "Reading copy").unwrap(), nord());
    assert_eq!(
        create(&dir, "Reading", DEFAULT_PROFILE),
        Err(ProfileError::Exists("Reading".into()))
    );
    rename(&dir, "Reading copy", "Night").unwrap();
    assert_eq!(list(&dir), [DEFAULT_PROFILE, "Night", "Reading"]);
    delete(&dir, "Night").unwrap();
    assert_eq!(
        delete(&dir, "Night"),
        Err(ProfileError::Missing("Night".into()))
    );
    assert_eq!(delete(&dir, DEFAULT_PROFILE), Err(ProfileError::Default));
    assert_eq!(
        rename(&dir, DEFAULT_PROFILE, "x"),
        Err(ProfileError::Default)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_name_is_safe_as_a_file_name_and_a_file_is_the_profile_schema_only() {
    for good in ["Reading", "night-2", "Café au lait", "v1.2"] {
        assert!(valid_name(good), "{good}");
    }
    for bad in [
        "",
        ".hidden",
        "../etc",
        "a/b",
        " padded",
        "x\n",
        &"y".repeat(65),
    ] {
        assert!(!valid_name(bad), "{bad:?}");
    }
    let dir = scratch("schema");
    std::fs::write(
        dir.join("Odd.json"),
        r#"{"theme":"nord","shell":"rm -rf /"}"#,
    )
    .unwrap();
    assert!(matches!(load(&dir, "Odd"), Err(ProfileError::Refused(m)) if m.contains("shell")));
    let _ = std::fs::remove_dir_all(&dir);
}

/// A profile file is plain JSON anything of the user's can write, and is
/// applied by name: it may never turn off asking before keys reach a pane,
/// or touch any other setting that guards access.
#[test]
fn a_profile_cannot_change_a_security_setting() {
    for key in SECURITY_KEYS {
        let text = format!(r#"{{"theme":"nord","{key}":false}}"#);
        let refused = parse("Sneaky", &text);
        assert!(
            matches!(&refused, Err(ProfileError::Refused(m)) if m.contains(key) && m.contains("guards access")),
            "{key}: {refused:?}"
        );
    }
    // Saved and loaded through the store, the same file is refused, so the
    // session keeps its global setting.
    let dir = scratch("security");
    std::fs::write(dir.join("Sneaky.json"), r#"{"sendAsk":false}"#).unwrap();
    let mut state = ManagedState::default();
    state
        .session_profiles
        .insert("work".into(), "Sneaky".into());
    assert!(profile_commands(&state, "work", &dir, &[]).is_empty());
    // And no field of a profile reaches the send-ask option.
    let all = Profile {
        theme: Some("nord".into()),
        theme_mode: Some("dark".into()),
        cursor_blink: Some(true),
        transparency: Some(true),
    };
    let commands = session_commands("work", "All", &all, &[]);
    assert!(
        !commands.iter().any(|c| c.contains("send-ask")),
        "{commands:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_theme_or_mode_no_theme_could_have_is_refused() {
    for bad in [
        r#"{"theme":"Tokyo Night"}"#,
        r#"{"theme":"../x"}"#,
        r#"{"theme":""}"#,
        r#"{"themeMode":"dusk"}"#,
    ] {
        assert!(
            matches!(parse("T", bad), Err(ProfileError::Refused(_))),
            "{bad}"
        );
    }
    assert!(parse("T", r#"{"theme":"devtools__dark","themeMode":"auto"}"#).is_ok());
}
