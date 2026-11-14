use super::is_users_own_socket;

/// The user's own server is the one on tmux's `default` socket, however the
/// socket is named: by that name, or by the path of that file in a socket
/// directory of theirs. A file called `default` anywhere else is not it.
#[test]
fn the_users_own_socket_is_recognised_by_name_and_by_path() {
    let root = std::env::temp_dir().join(format!("tmuxy-own-socket-{}", std::process::id()));
    let dir = root.join("tmux-1000");
    std::fs::create_dir_all(&dir).unwrap();
    let dirs = [std::fs::canonicalize(&dir).unwrap()];
    let path = |p: &std::path::Path| p.to_string_lossy().into_owned();

    assert!(is_users_own_socket("default", &dirs));
    assert!(is_users_own_socket(&path(&dir.join("default")), &dirs));
    assert!(!is_users_own_socket("tmuxy", &dirs));
    assert!(!is_users_own_socket(&path(&dir.join("tmuxy")), &dirs));
    assert!(!is_users_own_socket(&path(&root.join("default")), &dirs));
    std::fs::remove_dir_all(&root).unwrap();
}
