//! Generates the lists of files the binary bundles (`session::assets`): every
//! built-in theme under the UI's `public/themes/`, and the CLI dispatcher with
//! every helper script under `tmuxy-cli/bin/tmuxy/`. Read from the directories,
//! so a theme or a script added there ships with no list to update.

// A build script has nothing to recover to: a panic here IS its error report,
// so the workspace's ban on unwrap/expect does not apply.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn files_in(dir: &Path, keep: impl Fn(&str) -> bool) -> Vec<String> {
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.') && keep(name))
        .collect();
    names.sort();
    names
}

fn entry(out: &mut String, name: &str, path: &Path) {
    let _ = writeln!(
        out,
        "    ({name:?}, include_str!({:?})),",
        path.display().to_string()
    );
}

fn main() {
    let packages =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir")).join("..");
    let themes = packages.join("tmuxy-ui/public/themes");
    let bin = packages.join("tmuxy-cli/bin");

    let mut out = String::from("pub(super) const BUNDLED_THEMES: &[(&str, &str)] = &[\n");
    for name in files_in(&themes, |n| n.ends_with(".css")) {
        entry(&mut out, &name, &themes.join(&name));
    }
    out.push_str("];\n\npub(super) const BUNDLED_BIN_SCRIPTS: &[(&str, &str)] = &[\n");
    // The dispatcher first: the rest are what it dispatches to.
    entry(&mut out, "tmuxy-cli", &bin.join("tmuxy-cli"));
    for name in files_in(&bin.join("tmuxy"), |_| true) {
        entry(
            &mut out,
            &format!("tmuxy/{name}"),
            &bin.join("tmuxy").join(&name),
        );
    }
    out.push_str("];\n");

    let dest = PathBuf::from(std::env::var("OUT_DIR").expect("out dir")).join("bundled.rs");
    std::fs::write(dest, out).expect("write bundled.rs");
}
