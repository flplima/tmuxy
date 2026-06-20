use std::fs;
use std::path::PathBuf;

fn main() {
    sync_tauri_conf_version();
    tauri_build::build()
}

// Keep tauri.conf.json's `version` field in sync with the workspace
// [workspace.package].version. Without this, the value drifts on every release
// bump and Tauri produces artifacts named after the stale version, breaking the
// Homebrew cask URL (which is templated from the tag).
fn sync_tauri_conf_version() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set"));
    let workspace_toml = manifest_dir.join("../../Cargo.toml");
    let tauri_conf = manifest_dir.join("tauri.conf.json");

    println!("cargo:rerun-if-changed={}", workspace_toml.display());
    println!("cargo:rerun-if-changed={}", tauri_conf.display());

    let toml = fs::read_to_string(&workspace_toml)
        .unwrap_or_else(|e| panic!("read {}: {}", workspace_toml.display(), e));
    let version = extract_workspace_version(&toml).unwrap_or_else(|| {
        panic!(
            "no [workspace.package].version in {}",
            workspace_toml.display()
        )
    });

    let conf = fs::read_to_string(&tauri_conf)
        .unwrap_or_else(|e| panic!("read {}: {}", tauri_conf.display(), e));
    let updated = replace_json_version(&conf, &version);
    if updated != conf {
        fs::write(&tauri_conf, updated)
            .unwrap_or_else(|e| panic!("write {}: {}", tauri_conf.display(), e));
        println!(
            "cargo:warning=synced tauri.conf.json version to {}",
            version
        );
    }
}

fn extract_workspace_version(toml: &str) -> Option<String> {
    let mut in_section = false;
    for line in toml.lines() {
        let trimmed = line.trim();
        if let Some(header) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            in_section = header.trim() == "workspace.package";
            continue;
        }
        if in_section {
            if let Some(rest) = trimmed.strip_prefix("version") {
                let value = rest
                    .trim_start_matches(|c: char| c.is_whitespace() || c == '=')
                    .trim();
                let stripped = value.trim_matches('"');
                if !stripped.is_empty() {
                    return Some(stripped.to_string());
                }
            }
        }
    }
    None
}

// Minimal in-place rewrite of the top-level `"version": "..."` field. Avoids
// pulling serde_json into build-dependencies and preserves the file's exact
// formatting (indentation, trailing comma, line endings) so a no-op sync
// produces zero git churn.
fn replace_json_version(json: &str, version: &str) -> String {
    let mut out = String::with_capacity(json.len());
    let mut done = false;
    for line in json.split_inclusive('\n') {
        if !done && line.trim_start().starts_with("\"version\"") {
            let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
            let has_comma = line
                .trim_end_matches(['\n', '\r'])
                .trim_end()
                .ends_with(',');
            let line_ending = if line.ends_with("\r\n") {
                "\r\n"
            } else if line.ends_with('\n') {
                "\n"
            } else {
                ""
            };
            out.push_str(&format!(
                "{}\"version\": \"{}\"{}{}",
                indent,
                version,
                if has_comma { "," } else { "" },
                line_ending
            ));
            done = true;
        } else {
            out.push_str(line);
        }
    }
    out
}
