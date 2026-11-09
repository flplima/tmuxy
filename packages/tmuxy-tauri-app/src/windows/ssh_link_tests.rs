use super::*;

fn form(host: &str) -> SshForm {
    SshForm {
        host: host.to_string(),
        ..SshForm::default()
    }
}

/// A file that exists, for the key and certificate fields.
fn some_file(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("tmuxy-ssh-test-{}-{name}", std::process::id()));
    let Ok(()) = fs::write(&path, "key") else {
        panic!("could not write {}", path.display());
    };
    path
}

#[test]
fn a_host_alone_is_enough_and_user_at_host_fills_the_user() {
    let Ok(alone) = form("box.example.com").checked() else {
        panic!("a bare host is a form");
    };
    assert_eq!((alone.host.as_str(), alone.user), ("box.example.com", None));

    let Ok(typed) = form(" me@box ").checked() else {
        panic!("user@host in the host field is a form");
    };
    assert_eq!(
        (typed.host.as_str(), typed.user.as_deref()),
        ("box", Some("me"))
    );

    // A user field that was filled wins over one typed into the host.
    let mut both = form("me@box");
    both.user = Some("admin".to_string());
    let Ok(both) = both.checked() else {
        panic!("both is a form");
    };
    assert_eq!(both.user.as_deref(), Some("admin"));
}

#[test]
fn an_option_a_port_in_the_host_or_port_zero_is_refused() {
    for host in ["-oProxyCommand=sh", "box:2222", "a b", "", "me@-o"] {
        assert!(form(host).checked().is_err(), "{host:?} passed");
    }
    let mut zero = form("box");
    zero.port = Some(0);
    assert!(zero.checked().is_err());
    let mut user = form("box");
    user.user = Some("-oProxyCommand=sh".to_string());
    assert!(user.checked().is_err());
}

#[test]
fn a_key_must_be_an_existing_file_its_config_can_quote() {
    let mut missing = form("box");
    missing.identity_file = Some("/no/such/key".to_string());
    assert!(missing.checked().is_err());

    let mut relative = form("box");
    relative.identity_file = Some("id_ed25519".to_string());
    assert!(relative.checked().is_err());

    let quoted = some_file("has\"quote");
    let mut bad = form("box");
    bad.identity_file = Some(quoted.to_string_lossy().into_owned());
    assert!(bad.checked().is_err());
    let _ = fs::remove_file(quoted);
}

#[test]
fn the_config_carries_what_was_filled_ahead_of_the_users_own() {
    let key = some_file("key with space");
    let cert = some_file("key-cert.pub");
    let mut full = form("box");
    full.user = Some("me".to_string());
    full.port = Some(2222);
    full.identity_file = Some(key.to_string_lossy().into_owned());
    full.certificate_file = Some(cert.to_string_lossy().into_owned());
    let Ok(checked) = full.checked() else {
        panic!("a full form is a form");
    };
    let text = checked.config(Path::new("/tmp/tmuxy-ssh-1/win2-%C"), None);
    let block = text.split("Host *").next().unwrap_or_default();
    for line in [
        "Host box\n",
        "  User me\n",
        "  Port 2222\n",
        &format!("  IdentityFile \"{}\"\n", key.display()),
        "  IdentitiesOnly yes\n",
        &format!("  CertificateFile \"{}\"\n", cert.display()),
        "  ControlPath /tmp/tmuxy-ssh-1/win2-%C\n",
        "  StrictHostKeyChecking yes\n",
    ] {
        assert!(block.contains(line), "{line:?} missing from:\n{text}");
    }
    // The user's config comes after, so the form's values are the ones read.
    assert!(text.ends_with("Host *\n  Include ~/.ssh/config\n  Include /etc/ssh/ssh_config\n"));

    // Nothing filled in: no user, port or key line, so ssh's own defaults hold.
    let Ok(bare) = form("box").checked() else {
        panic!("a bare host is a form");
    };
    let bare = bare.config(Path::new("/tmp/x"), None);
    for absent in ["User ", "Port ", "IdentityFile", "CertificateFile"] {
        assert!(!bare.contains(absent), "{absent} in:\n{bare}");
    }
    let _ = fs::remove_file(key);
    let _ = fs::remove_file(cert);
}

#[test]
fn a_confirmed_fingerprint_trusts_the_host_on_first_use_only() {
    let mut trusted = form("box");
    trusted.trust_new_host = true;
    let Ok(trusted) = trusted.checked() else {
        panic!("a form");
    };
    assert!(trusted
        .config(Path::new("/tmp/x"), None)
        .contains("StrictHostKeyChecking accept-new\n"));
    // A known-hosts file of the setup's own, when one is named.
    assert!(trusted
        .config(
            Path::new("/tmp/x"),
            Some(Path::new("/state/ssh_known_hosts"))
        )
        .contains("  UserKnownHostsFile \"/state/ssh_known_hosts\"\n"));
}

#[test]
fn ssh_unknown_host_is_told_apart_from_a_changed_one_and_a_refusal() {
    assert!(is_unknown_host(
        "No ED25519 host key is known for box and you have requested strict checking.\nHost key verification failed."
    ));
    assert!(!is_unknown_host(
        "@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\nHost key verification failed."
    ));
    assert!(!is_unknown_host(
        "me@box: Permission denied (publickey,password)."
    ));
    assert_eq!(
        ssh_reason("\nme@box: Permission denied (publickey,password).\n"),
        "ssh: me@box: Permission denied (publickey,password)."
    );
}

#[test]
fn the_fingerprint_shown_is_for_the_key_type_ssh_asked_about() {
    let listed = "3072 SHA256:rsaHASH box (RSA)\n256 SHA256:edHASH box (ED25519)\n";
    assert_eq!(
        pick_fingerprint(listed, "No ED25519 host key is known for box"),
        Some("ED25519 SHA256:edHASH".to_string())
    );
    assert_eq!(
        pick_fingerprint(listed, ""),
        Some("RSA SHA256:rsaHASH".to_string())
    );
    assert_eq!(pick_fingerprint("", ""), None);
}

#[test]
fn the_host_field_offers_the_named_hosts_of_the_users_config() {
    let config = "Host work box2\n  HostName 10.0.0.2\nHost *.internal !bad\nhost=pi\nMatch all\nHost work\n";
    assert_eq!(hosts_in(config), ["work", "box2", "pi"]);
}

#[test]
fn a_link_runs_tmux_through_its_own_config() {
    let link = SshLink {
        config: PathBuf::from("/tmp/tmuxy-ssh-1/win2.conf"),
        host: "box".to_string(),
    };
    assert_eq!(link.tail(), "-F /tmp/tmuxy-ssh-1/win2.conf box");
}

#[test]
fn a_control_socket_names_the_app_instance_that_made_it() {
    let hash = "99b1bde4371cd3b7d7612e41e8c3e381f1e11fb8";
    assert_eq!(socket_owner(&format!("win2-4242-{hash}")), Some(4242));
    assert_eq!(socket_owner(&format!("main-window-7-{hash}")), Some(7));
    for other in [
        "askpass",
        "win2.conf",
        "win2-x-abc",
        &format!("-4242-{hash}"),
        &format!("win2-{hash}"),
    ] {
        assert_eq!(socket_owner(other), None, "{other}");
    }
    let path = control_path(Path::new("/tmp/d"), "win3");
    assert_eq!(
        path,
        PathBuf::from(format!("/tmp/d/win3-{}-%C", std::process::id()))
    );
}
