use super::*;

fn spec() -> Spec {
    Spec {
        exe: "/opt/tmuxy/tmuxy".into(),
        subcommand: Some("server".into()),
        port: 9000,
        host: "127.0.0.1".into(),
        allowed_hosts: vec!["tmux.example.com".into()],
        path_env: Some("/usr/bin:/home/a b/bin".into()),
        env_file: "/home/u/.config/tmuxy/server.env".into(),
        log_file: "/home/u/.local/state/tmuxy/server.log".into(),
    }
}

fn ctx() -> Ctx {
    Ctx {
        home: "/home/u".into(),
        uid: 501,
        user: Some("u".into()),
    }
}

fn strings(steps: &[Step]) -> Vec<String> {
    steps.iter().map(Step::display).collect()
}

#[test]
fn the_unit_runs_the_binary_with_the_flags_and_restarts_on_failure() {
    let text = systemd_unit(&spec());
    assert!(text.starts_with("# tmuxy-managed:"));
    assert!(text.contains(
        "ExecStart=/opt/tmuxy/tmuxy server --port 9000 --host 127.0.0.1 --allowed-host tmux.example.com\n"
    ));
    assert!(text.contains("EnvironmentFile=-/home/u/.config/tmuxy/server.env\n"));
    assert!(text.contains("Environment=\"PATH=/usr/bin:/home/a b/bin\"\n"));
    assert!(text.contains("Restart=on-failure\n"));
    assert!(text.contains("WantedBy=default.target\n"));
}

#[test]
fn a_standalone_binary_has_no_subcommand_and_odd_paths_are_quoted() {
    let mut s = spec();
    s.subcommand = None;
    s.exe = "/opt/my apps/100%/tmuxy-server".into();
    let text = systemd_unit(&s);
    assert!(text.contains("ExecStart=\"/opt/my apps/100%%/tmuxy-server\" --port 9000"));
}

#[test]
fn no_password_is_ever_written_into_a_unit_or_a_plist() {
    for text in [systemd_unit(&spec()), launchd_plist(&spec())] {
        assert!(!text.contains("--password"));
        assert!(!text.to_lowercase().contains("secret"));
    }
}

#[test]
fn the_plist_runs_at_load_keeps_alive_and_logs_under_the_state_dir() {
    let text = launchd_plist(&spec());
    assert!(text.contains("<!-- tmuxy-managed:"));
    assert!(text.contains("<string>sh.tmuxy.server</string>"));
    assert!(text.contains("<key>RunAtLoad</key>\n  <true/>"));
    assert!(text.contains("<key>KeepAlive</key>\n  <true/>"));
    assert!(text.contains("<string>/home/u/.local/state/tmuxy/server.log</string>"));
    assert!(text.contains("<string>/home/u/.config/tmuxy/server.env</string>"));
    assert!(text.contains("<string>/opt/tmuxy/tmuxy</string>\n    <string>server</string>"));
}

#[test]
fn xml_in_a_path_is_escaped() {
    let mut s = spec();
    s.exe = "/opt/a&b/<t>".into();
    assert!(launchd_plist(&s).contains("/opt/a&amp;b/&lt;t&gt;"));
}

#[test]
fn unit_paths_are_the_user_level_ones() {
    let home = Path::new("/home/u");
    assert_eq!(
        unit_path(Manager::Systemd, home),
        PathBuf::from("/home/u/.config/systemd/user/tmuxy.service")
    );
    assert_eq!(
        unit_path(Manager::Launchd, home),
        PathBuf::from("/home/u/Library/LaunchAgents/sh.tmuxy.server.plist")
    );
}

#[test]
fn a_fresh_systemd_install_reloads_enables_and_lingers() {
    let plan = install_plan(Manager::Systemd, &spec(), &ctx(), false, &Existing::Absent).unwrap();
    assert_eq!(
        strings(&plan.steps),
        [
            "systemctl --user daemon-reload",
            "systemctl --user enable --now tmuxy.service",
            "loginctl enable-linger u",
        ]
    );
    assert!(plan.linger);
    assert!(plan.steps[2].optional && plan.steps[2].linger);
}

#[test]
fn no_linger_leaves_lingering_alone() {
    let plan = install_plan(Manager::Systemd, &spec(), &ctx(), true, &Existing::Absent).unwrap();
    assert!(!plan.linger);
    assert!(!strings(&plan.steps).iter().any(|s| s.contains("linger")));
}

#[test]
fn installing_again_restarts_only_when_the_unit_changed() {
    let same = Existing::Ours(systemd_unit(&spec()));
    let again = install_plan(Manager::Systemd, &spec(), &ctx(), false, &same).unwrap();
    assert!(!strings(&again.steps).iter().any(|s| s.contains("restart")));
    let old = Existing::Ours("# tmuxy-managed: old\nExecStart=/old\n".into());
    let updated = install_plan(Manager::Systemd, &spec(), &ctx(), false, &old).unwrap();
    assert!(strings(&updated.steps).contains(&"systemctl --user restart tmuxy.service".to_string()));
}

#[test]
fn a_file_tmuxy_did_not_write_is_refused_and_named() {
    let existing = Existing::classify(Some("[Service]\nExecStart=/bin/mine\n"));
    assert_eq!(existing, Existing::Foreign);
    let err = install_plan(Manager::Systemd, &spec(), &ctx(), false, &existing).unwrap_err();
    assert_eq!(
        err,
        ServiceError::Foreign("/home/u/.config/systemd/user/tmuxy.service".into())
    );
    assert!(err.to_string().contains("tmuxy.service"));
    assert!(uninstall_plan(Manager::Systemd, &ctx(), &existing).is_err());
}

#[test]
fn a_file_with_the_marker_is_ours() {
    let text = systemd_unit(&spec());
    assert_eq!(
        Existing::classify(Some(&text)),
        Existing::Ours(text.clone())
    );
    assert_eq!(Existing::classify(None), Existing::Absent);
}

#[test]
fn launchd_boots_out_before_it_bootstraps() {
    let plan = install_plan(Manager::Launchd, &spec(), &ctx(), false, &Existing::Absent).unwrap();
    assert_eq!(
        strings(&plan.steps),
        [
            "launchctl bootout gui/501/sh.tmuxy.server",
            "launchctl bootstrap gui/501 /home/u/Library/LaunchAgents/sh.tmuxy.server.plist",
        ]
    );
    assert!(plan.steps[0].optional && !plan.steps[1].optional);
    assert!(!plan.linger);
}

#[test]
fn uninstall_stops_removes_our_file_and_reloads() {
    let ours = Existing::Ours(systemd_unit(&spec()));
    let plan = uninstall_plan(Manager::Systemd, &ctx(), &ours).unwrap();
    assert_eq!(
        strings(&plan.before),
        ["systemctl --user disable --now tmuxy.service"]
    );
    assert!(plan.remove_file);
    assert_eq!(strings(&plan.after), ["systemctl --user daemon-reload"]);
    assert!(!strings(&plan.before).iter().any(|s| s.contains("linger")));
}

#[test]
fn uninstall_with_nothing_installed_does_nothing() {
    let plan = uninstall_plan(Manager::Launchd, &ctx(), &Existing::Absent).unwrap();
    assert!(!plan.remove_file && plan.before.is_empty() && plan.after.is_empty());
}

#[test]
fn a_loopback_host_needs_no_secret_file() {
    assert!(check_secret(true, &EnvFile::Missing, Path::new("/e")).is_ok());
}

#[test]
fn a_routable_host_needs_a_private_file_with_a_password() {
    let path = Path::new("/c/server.env");
    let missing = check_secret(false, &EnvFile::Missing, path).unwrap_err();
    assert!(missing.to_string().contains("TMUXY_PASSWORD"));
    let empty = EnvFile::parse("OTHER=1\nTMUXY_PASSWORD=\n", 0o600);
    assert!(check_secret(false, &empty, path).is_err());
    let open = EnvFile::parse("TMUXY_PASSWORD=pw\n", 0o644);
    let err = check_secret(false, &open, path).unwrap_err();
    assert!(err.to_string().contains("chmod 600"));
    let good = EnvFile::parse("TMUXY_PASSWORD=pw\n", 0o600);
    assert!(check_secret(false, &good, path).is_ok());
}

#[test]
fn the_linger_hint_names_the_admin_command() {
    assert!(linger_hint(Some("u")).contains("sudo loginctl enable-linger u"));
}
