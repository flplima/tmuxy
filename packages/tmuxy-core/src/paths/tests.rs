use super::*;

/// The rows of the markdown table under `heading` in `text`, split into
/// cells with their backticks dropped.
fn table_rows(text: &str, heading: &str) -> Vec<Vec<String>> {
    text.split(heading)
        .nth(1)
        .expect("heading")
        .lines()
        .skip_while(|l| !l.starts_with('|'))
        .take_while(|l| l.starts_with('|'))
        .skip(2)
        .map(|l| {
            l.trim_matches('|')
                .split('|')
                .map(|c| c.trim().replace('`', ""))
                .collect()
        })
        .collect()
}

/// Whether a README's shown file name (`themes/<name>.css`) is `file`.
fn shows(cell: &str, file: &File) -> bool {
    cell == file.name || (file.name.ends_with('/') && cell.starts_with(file.name))
}

fn yes(cell: &str) -> bool {
    cell == "yes"
}

/// The config README (mirrored into the data dir as the user's guide)
/// lists every file of the table, and only those, with the same dir,
/// owner and rules.
#[test]
fn the_config_readme_lists_every_file_and_no_other() {
    let readme = include_str!("../../assets/config-README.md");
    let rows = table_rows(readme, "## The files, and who owns them");
    assert_eq!(rows.len(), FILES.len(), "{rows:?}");
    for file in FILES {
        let row = rows
            .iter()
            .find(|r| r[1] == file.dir.as_str() && shows(&r[0], file))
            .unwrap_or_else(|| panic!("the README has no row for {file:?}"));
        let owner = if row[2] == "you" {
            "user"
        } else {
            row[2].as_str()
        };
        assert_eq!(owner, file.dir.owner(), "{file:?}");
        assert_eq!(yes(&row[3]), file.safe_to_edit, "{file:?}");
        assert_eq!(yes(&row[4]), file.safe_to_symlink(), "{file:?}");
    }
}

#[test]
fn a_layout_resolves_every_file_under_its_dir() {
    let layout = Layout {
        config: "/c".into(),
        data: "/d".into(),
        state: "/s".into(),
        home: "/h".into(),
    };
    for file in FILES {
        assert!(layout.path(file).starts_with(layout.dir(file.dir)));
    }
    assert_eq!(layout.user_conf(), PathBuf::from("/c/tmuxy.conf"));
    assert_eq!(layout.path(&SESSIONS), PathBuf::from("/s/sessions"));
    let report = layout.report();
    assert_eq!(report["dirs"]["data"], "/d");
    assert_eq!(report["files"][0]["path"], "/c/tmuxy.conf");
    assert_eq!(report["files"][0]["owner"], "user");
}

/// The dev server, the E2E harness and the snapshot tests all point
/// `TMUXY_STATE_DIR` somewhere of their own, and SECURITY.md promises the
/// trace lives there too. The trace's own resolution ignored the variable,
/// so `tmuxy trace --mark` under it stamped the machine-wide file.
#[test]
fn the_override_moves_the_whole_state_dir() {
    let dir = state_dir_from(Some(OsString::from("/tmp/tmuxy-test-state")));
    assert_eq!(dir, PathBuf::from("/tmp/tmuxy-test-state"));
    assert_eq!(
        dir.join("trace.ndjson"),
        PathBuf::from("/tmp/tmuxy-test-state/trace.ndjson")
    );
}

#[test]
fn an_empty_override_means_the_platform_default() {
    for unset in [None, Some(OsString::new())] {
        let dir = state_dir_from(unset);
        assert_eq!(dir.file_name().and_then(|n| n.to_str()), Some("tmuxy"));
    }
}

#[test]
fn the_data_dir_is_the_override_then_xdg_then_local_share_on_every_os() {
    let home = Some(PathBuf::from("/home/u"));
    assert_eq!(
        data_dir_from(Some("/tmp/d".into()), Some("/x".into()), home.clone()),
        PathBuf::from("/tmp/d")
    );
    assert_eq!(
        data_dir_from(None, Some("/x".into()), home.clone()),
        PathBuf::from("/x/tmuxy")
    );
    for ignored in [None, Some(OsString::from("relative/path"))] {
        assert_eq!(
            data_dir_from(Some(OsString::new()), ignored, home.clone()),
            PathBuf::from("/home/u/.local/share/tmuxy")
        );
    }
    let missing_home = data_dir_from(None, None, None);
    assert!(missing_home.is_absolute());
    assert_ne!(
        missing_home,
        std::env::temp_dir()
            .join(".local")
            .join("share")
            .join("tmuxy")
    );
}

#[test]
fn the_resolved_home_is_always_absolute() {
    assert!(resolved_home_dir().is_absolute());
}

#[cfg(unix)]
#[test]
fn the_fallback_home_is_a_private_dir_the_user_owns_and_never_a_symlink() {
    use std::os::unix::fs::PermissionsExt;

    // SAFETY: getuid() has no preconditions.
    let uid = unsafe { libc::getuid() };
    let base = std::env::temp_dir().join(format!("tmuxy-home-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let dir = base.join(format!("tmuxy-{uid}"));
    let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;

    // Created owner-only when missing.
    assert_eq!(private_uid_dir(&base, uid).unwrap(), dir);
    assert_eq!(mode(&dir), 0o700);

    // An existing one of the user's own is tightened.
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(private_uid_dir(&base, uid).unwrap(), dir);
    assert_eq!(mode(&dir), 0o700);

    // Another user's directory under the name is refused (a test cannot
    // chown, so it asks for the directory as a uid that does not own it).
    let other = uid.wrapping_add(1);
    std::fs::rename(&dir, base.join(format!("tmuxy-{other}"))).unwrap();
    assert!(private_uid_dir(&base, other).is_err());

    // A symlink under the name is refused, even to a directory the user owns.
    let decoy = base.join("decoy");
    std::fs::create_dir(&decoy).unwrap();
    std::os::unix::fs::symlink(&decoy, &dir).unwrap();
    assert!(private_uid_dir(&base, uid).is_err());

    std::fs::remove_dir_all(&base).unwrap();
}
