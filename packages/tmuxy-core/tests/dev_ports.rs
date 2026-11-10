//! The configs that name the dev loop's ports, which nothing generates a
//! value into, held to tmuxy-core's: the desktop app's `devUrl`, the
//! devcontainer's forwarded ports, the UI's `predev`, which frees Vite's port
//! before Vite binds it, and the Vite config itself (a TypeScript project of
//! its own, which cannot import the app's generated module).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::Path;

use tmuxy_core::constants::{DEFAULT_SERVER_PORT, DEV_VITE_PORT};

fn read(file: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(file);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn the_configs_name_the_ports_tmuxy_core_has() {
    let tauri: serde_json::Value =
        serde_json::from_str(&read("packages/tmuxy-tauri-app/tauri.conf.json")).unwrap();
    assert_eq!(
        tauri["build"]["devUrl"],
        format!("http://localhost:{DEV_VITE_PORT}")
    );

    let vite = read("packages/tmuxy-ui/vite.config.ts");
    assert_eq!(
        vite.matches(&format!("ort: {DEV_VITE_PORT},")).count(),
        3,
        "vite.config.ts: port, hmr.port and hmr.clientPort"
    );

    // JSON with comments, so read for the one line.
    let devcontainer = read(".devcontainer/devcontainer.json");
    assert!(
        devcontainer.contains(&format!(
            "\"forwardPorts\": [{DEFAULT_SERVER_PORT}, {DEV_VITE_PORT}]"
        )),
        "devcontainer.json forwards other ports"
    );
}
