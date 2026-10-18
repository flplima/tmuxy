use super::*;

/// SEC-12: a `--read-only` viewer beside a writer on the same socket used
/// to get `list-panes -a` — the repo path and branch of every pane in
/// every session on the tmux server, not just the one it was shown.
#[test]
fn a_pinned_server_only_lists_its_own_sessions_panes() {
    assert_eq!(
        list_pane_paths_cmd(Some("shared")),
        "list-panes -s -t 'shared' -F '#{pane_current_path}'"
    );
}

#[test]
fn an_unpinned_server_still_lists_every_pane() {
    assert_eq!(
        list_pane_paths_cmd(None),
        "list-panes -a -F '#{pane_current_path}'"
    );
}

/// The name is quoted for the same reason SEC-14 quotes it: the listing is
/// a control-mode command line, where `;` starts another command.
#[test]
fn a_session_name_is_quoted_into_the_listing() {
    assert_eq!(
        list_pane_paths_cmd(Some("a ; kill-server")),
        "list-panes -s -t 'a ; kill-server' -F '#{pane_current_path}'"
    );
}

#[test]
fn empty_paths_never_fall_back_to_an_ambient_scan() {
    assert_eq!(list_git_worktrees(Vec::new()), Ok(Vec::new()));
}

#[test]
fn rejects_requests_over_the_documented_path_limit() {
    let paths = vec!["/same/path".to_string(); MAX_DISCOVERY_PATHS + 1];

    assert_eq!(
        list_git_worktrees(paths),
        Err(WorktreeDiscoveryError::TooManyPaths {
            count: MAX_DISCOVERY_PATHS + 1,
            max: MAX_DISCOVERY_PATHS,
        })
    );
}

#[test]
fn canonical_input_paths_are_deduplicated_before_git_runs() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let cargo_toml = manifest_dir.join("Cargo.toml");
    let with_parent_component = manifest_dir.join("src").join("..");
    let directories = canonical_input_directories(vec![
        manifest_dir.to_string_lossy().into_owned(),
        cargo_toml.to_string_lossy().into_owned(),
        with_parent_component.to_string_lossy().into_owned(),
    ]);
    let Ok(canonical_manifest_dir) = fs::canonicalize(manifest_dir) else {
        panic!("manifest directory should canonicalize");
    };

    assert_eq!(directories, vec![canonical_manifest_dir]);
}

#[test]
fn pane_listing_paths_are_deduplicated_trimmed_and_capped() {
    let listing = "/repo\n/repo\n  /other  \n\n/third\n";
    assert_eq!(
        paths_from_pane_listing(listing),
        ["/repo", "/other", "/third"]
    );

    let many: String = (0..MAX_DISCOVERY_PATHS + 5)
        .map(|i| format!("/p{i}\n"))
        .collect();
    assert_eq!(paths_from_pane_listing(&many).len(), MAX_DISCOVERY_PATHS);
}

#[test]
fn newline_porcelain_maps_onto_the_nul_layout() {
    let newline = b"worktree /repos/project\nHEAD abc\nbranch refs/heads/main\n\n";
    let parsed = parse_worktree_porcelain(&newline_porcelain_as_nul(newline));
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].path, PathBuf::from("/repos/project"));
    assert_eq!(parsed[0].branch.as_deref(), Some("refs/heads/main"));
}

#[test]
fn an_old_git_rejecting_z_is_told_apart_from_a_real_failure() {
    assert!(rejects_z_flag(
        b"error: unknown switch `z'\nusage: git worktree list"
    ));
    assert!(!rejects_z_flag(
        b"fatal: detected dubious ownership in repository at '/repo'\n"
    ));
}

#[test]
fn a_path_outside_git_and_an_unreadable_one_are_skipped_not_fatal() {
    // A directory that is certainly not inside a repository, plus a path
    // that does not exist: neither may fail the whole discovery.
    let outside = std::env::temp_dir().to_string_lossy().into_owned();
    let missing = "/definitely/not/a/real/path/for/tmuxy".to_string();
    let result = list_git_worktrees(vec![outside, missing]);
    assert!(result.is_ok());
}

#[test]
fn only_classifies_the_standard_non_repository_failure_as_a_skip() {
    assert!(is_not_git_repository(
        b"fatal: not a git repository (or any of the parent directories): .git\n"
    ));
    assert!(is_not_git_repository(
        b"fatal: not a git repository (or any parent up to mount point /)\n\
Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n"
    ));
    assert!(!is_not_git_repository(
        b"fatal: detected dubious ownership in repository at '/repo'\n"
    ));
    assert!(!is_not_git_repository(
        b"fatal: cannot open '.git/FETCH_HEAD': Permission denied\n"
    ));
    assert!(!is_not_git_repository(b""));
}

#[test]
fn parses_worktree_porcelain_records_and_flags() {
    let parsed = parse_worktree_porcelain(
        b"worktree /repos/project\0\
HEAD 0123456789abcdef\0\
branch refs/heads/main\0\0\
worktree /repos/project-feature\0\
HEAD fedcba9876543210\0\
branch refs/heads/feature/nested\0\
locked checked out by automation\0\0\
worktree /repos/project-old\0\
HEAD aaaaaaaaaaaaaaaa\0\
detached\0\
prunable gitdir file points to non-existent location\0\0",
    );

    assert_eq!(parsed.len(), 3);
    assert_eq!(parsed[0].path, PathBuf::from("/repos/project"));
    assert_eq!(
        parsed[1].branch.as_deref(),
        Some("refs/heads/feature/nested")
    );
    assert!(parsed[1].locked);
    assert!(parsed[2].detached);
    assert!(parsed[2].prunable);
}

#[test]
fn parser_flushes_a_record_without_a_blank_separator() {
    let parsed = parse_worktree_porcelain(
        b"worktree /one\0HEAD abc\0branch refs/heads/main\0\
worktree /two\0HEAD def\0detached\0",
    );

    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[1].path, PathBuf::from("/two"));
    assert!(parsed[1].detached);
}

#[test]
fn nul_parser_preserves_newlines_tabs_and_spaces_in_paths() {
    let parsed = parse_worktree_porcelain(
        b"worktree /repos/line\nwith\ttabs and spaces \0\
HEAD abc\0branch refs/heads/main\0\0",
    );

    assert_eq!(
        parsed[0].path,
        PathBuf::from("/repos/line\nwith\ttabs and spaces ")
    );
}

#[test]
fn normalizes_common_branch_refs() {
    assert_eq!(normalize_branch("refs/heads/main"), "main");
    assert_eq!(
        normalize_branch("refs/heads/feature/worktree-tree"),
        "feature/worktree-tree"
    );
    assert_eq!(normalize_branch("refs/remotes/origin/main"), "origin/main");
    assert_eq!(normalize_branch("refs/tags/v1.0.0"), "v1.0.0");
}

#[test]
fn serializes_the_frontend_wire_shape_in_camel_case() {
    let Ok(value) = serde_json::to_value(GitWorktree {
        path: "/repo".to_string(),
        branch: Some("main".to_string()),
        head: "abc".to_string(),
        is_main: true,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
    }) else {
        panic!("worktree should serialize");
    };

    assert_eq!(value["isMain"], true);
    assert_eq!(value["detached"], false);
    assert_eq!(value["bare"], false);
    assert!(value.get("is_main").is_none());
}

#[test]
fn omits_branch_for_detached_or_bare_worktrees() {
    let Ok(value) = serde_json::to_value(GitWorktree {
        path: "/repo".to_string(),
        branch: None,
        head: "abc".to_string(),
        is_main: false,
        detached: true,
        bare: false,
        locked: false,
        prunable: false,
    }) else {
        panic!("worktree should serialize");
    };

    assert!(value.get("branch").is_none());
    assert_eq!(value["detached"], true);
}
