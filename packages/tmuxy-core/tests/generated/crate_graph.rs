//! The workspace's crate graph, for `bin/ci/crate-graph.json`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use super::{packages, HEADER};

/// Every workspace crate and the repo directories it is built from: its own
/// and those of the local crates under it (path dependencies and the
/// workspace's `[patch]` crates; build and normal dependencies, not dev
/// ones), from `cargo metadata`. What a watcher or a cache key over a crate's
/// sources reads (`bin/dev-server`, `bin/ci/crate-graph.test.mjs`).
pub fn crate_graph_json() -> String {
    let root = packages().join("..").canonicalize().unwrap();
    let out = std::process::Command::new(env!("CARGO"))
        .args(["metadata", "--format-version", "1", "--no-deps"])
        .current_dir(&root)
        .output()
        .expect("cargo metadata runs");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let metadata: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let manifest: toml::Table = std::fs::read_to_string(root.join("Cargo.toml"))
        .unwrap()
        .parse()
        .unwrap();
    let relative = |dir: &Path| {
        dir.strip_prefix(&root)
            .unwrap_or_else(|_| panic!("{} is outside the repo", dir.display()))
            .display()
            .to_string()
    };
    let patched: BTreeMap<String, String> = manifest
        .get("patch")
        .and_then(|p| p.get("crates-io"))
        .and_then(|t| t.as_table())
        .into_iter()
        .flatten()
        .filter_map(|(name, spec)| {
            let path = spec.get("path")?.as_str()?;
            Some((name.clone(), relative(&root.join(path))))
        })
        .collect();
    let members: BTreeMap<String, (String, Vec<String>)> = metadata["packages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|package| {
            let dir = relative(
                Path::new(package["manifest_path"].as_str().unwrap())
                    .parent()
                    .unwrap(),
            );
            let local = package["dependencies"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|dep| dep["kind"].as_str() != Some("dev"))
                .filter_map(|dep| {
                    let name = dep["name"].as_str()?;
                    match dep["path"].as_str() {
                        Some(path) => Some(relative(Path::new(path))),
                        None => patched.get(name).cloned(),
                    }
                })
                .collect();
            (package["name"].as_str().unwrap().to_string(), (dir, local))
        })
        .collect();
    let by_dir: BTreeMap<&str, &Vec<String>> = members
        .values()
        .map(|(dir, deps)| (dir.as_str(), deps))
        .collect();
    let crates: serde_json::Map<String, serde_json::Value> = members
        .iter()
        .map(|(name, (dir, _))| {
            let mut closure = BTreeSet::new();
            let mut todo = vec![dir.clone()];
            while let Some(dir) = todo.pop() {
                if closure.insert(dir.clone()) {
                    todo.extend(
                        by_dir
                            .get(dir.as_str())
                            .into_iter()
                            .flat_map(|d| d.iter().cloned()),
                    );
                }
            }
            (name.clone(), serde_json::json!(closure))
        })
        .collect();
    let value = serde_json::json!({
        "_generated": HEADER.lines().collect::<Vec<_>>(),
        "crates": crates,
    });
    format!(
        "{}\n",
        serde_json::to_string_pretty(&value).unwrap_or_default()
    )
}
