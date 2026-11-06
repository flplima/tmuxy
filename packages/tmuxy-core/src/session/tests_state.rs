//! The files tmuxy writes for itself: the menu-state file (`tmuxy.state.json`)
//! through its one writer, and the CLI it mirrors.

use super::state::{read_managed_state_in, write_managed_state_in};
use super::*;
use crate::paths::Layout;

/// The state file holds every menu choice: setting one keeps the rest and
/// leaves valid JSON, whatever shape the file was in (`tmuxy config
/// use-tmux-conf` writes through here).
#[test]
fn setting_one_choice_keeps_the_others_and_the_file_valid() {
    for (before, after) in [
        (None, r#"{"use_tmux_conf":true}"#),
        (Some("{}\n"), r#"{"use_tmux_conf":true}"#),
        (Some("{\n}\n"), r#"{"use_tmux_conf":true}"#),
        (
            Some("{\n  \"theme\": \"nord\",\n  \"cursor_blink\": false\n}\n"),
            r#"{"theme":"nord","cursor_blink":false,"use_tmux_conf":true}"#,
        ),
        (
            Some(r#"{"use_tmux_conf":false}"#),
            r#"{"use_tmux_conf":true}"#,
        ),
    ] {
        let root = std::env::temp_dir().join(format!("tmuxy-state-bool-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let layout = Layout {
            config: root.join("config"),
            data: root.join("data"),
            state: root.join("state"),
            home: root.join("home"),
        };
        if let Some(before) = before {
            std::fs::create_dir_all(&layout.state).unwrap();
            std::fs::write(layout.state_file(), before).unwrap();
        }
        let set = ManagedState {
            use_tmux_conf: Some(true),
            ..Default::default()
        };
        write_managed_state_in(&layout, set).unwrap();
        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(layout.state_file()).unwrap()).unwrap();
        let want: serde_json::Value = serde_json::from_str(after).unwrap();
        assert_eq!(written, want, "{before:?}");
        assert_eq!(read_managed_state_in(&layout).use_tmux_conf, Some(true));
        std::fs::remove_dir_all(&root).unwrap();
    }
}

/// The CLI the app mirrors into the data dir says this build's version; the
/// checkout's copy holds only the placeholder (`tmuxy-cli` reads the tree's
/// package.json for it).
#[test]
fn the_mirrored_cli_carries_this_builds_version() {
    let root = std::env::temp_dir().join(format!("tmuxy-cli-version-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let layout = Layout {
        config: root.join("config"),
        data: root.join("data"),
        state: root.join("state"),
        home: root.join("home"),
    };
    let cli =
        std::fs::read_to_string(super::assets::ensure_bin_scripts_in(&layout).join("tmuxy-cli"))
            .unwrap();
    assert!(
        cli.contains(&format!("TMUXY_VERSION=\"{}\"", env!("CARGO_PKG_VERSION"))),
        "the version is not written in"
    );
    assert!(!cli.contains("@TMUXY_VERSION@"));
    let _ = std::fs::remove_dir_all(&root);
}
