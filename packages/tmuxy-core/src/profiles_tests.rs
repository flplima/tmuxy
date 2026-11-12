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
    assert!(matches!(
        load(&dir, "Odd"),
        Err(ProfileError::Unreadable(_))
    ));
    let _ = std::fs::remove_dir_all(&dir);
}
