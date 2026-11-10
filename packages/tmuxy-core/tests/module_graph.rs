//! Which of tmuxy-core's top-level modules uses which, held in a committed
//! list (`tests/generated/module_graph.txt`), with no cycle among them.
//!
//! The crate graph says which crate may depend on which (`packages/tmuxy-core/tests/generated/crate-graph.gen.json`);
//! inside the core, a module reaching into another is where one rule ends up
//! owned by two places. A new edge is a design decision: it fails here until
//! the list is rewritten with `UPDATE_GENERATED=1 cargo test -p tmuxy-core
//! --test module_graph`, which puts it in the diff for review. A cycle fails
//! whatever the list says: two modules that use each other are one module.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

fn src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// A file of tests, whose references are not the module's design.
fn is_test_file(name: &str) -> bool {
    name == "tests.rs" || name.starts_with("tests_") || name.ends_with("_tests.rs")
}

/// The top-level modules: `src/<name>.rs` and `src/<name>/`.
fn modules() -> BTreeSet<String> {
    std::fs::read_dir(src())
        .unwrap()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_test_file(&name) {
                return None;
            }
            let module = match name.strip_suffix(".rs") {
                Some(stem) => stem.to_string(),
                None if entry.path().is_dir() => name,
                None => return None,
            };
            (module != "lib").then_some(module)
        })
        .collect()
}

/// The first path segment of each `crate::…` a line of code names, grouped
/// imports (`crate::{a, b::c}`) included.
pub fn crate_references(code: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = code;
    while let Some(at) = rest.find("crate::") {
        rest = &rest[at + "crate::".len()..];
        if let Some(group) = rest.strip_prefix('{') {
            let mut depth = 0;
            let mut item = String::new();
            for ch in group.chars() {
                match ch {
                    '{' => depth += 1,
                    '}' if depth == 0 => break,
                    '}' => depth -= 1,
                    ',' if depth == 0 => {
                        found.push(item.trim().split("::").next().unwrap_or("").to_string());
                        item.clear();
                        continue;
                    }
                    _ => {}
                }
                item.push(ch);
            }
            found.push(item.trim().split("::").next().unwrap_or("").to_string());
        } else {
            let ident: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            found.push(ident);
        }
    }
    found.retain(|m| !m.is_empty() && m != "self");
    found
}

fn rust_files(dir: &Path, acc: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, acc);
        } else if path.extension().is_some_and(|e| e == "rs") {
            acc.push(path);
        }
    }
}

/// Module → the other top-level modules its code uses.
fn graph() -> BTreeMap<String, BTreeSet<String>> {
    let modules = modules();
    let mut edges: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut files = Vec::new();
    rust_files(&src(), &mut files);
    for file in files {
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        let relative = file.strip_prefix(src()).unwrap();
        let top = relative
            .components()
            .next()
            .unwrap()
            .as_os_str()
            .to_string_lossy();
        let owner = top.strip_suffix(".rs").unwrap_or(&top).to_string();
        if is_test_file(&name) || !modules.contains(&owner) {
            continue;
        }
        for line in std::fs::read_to_string(&file).unwrap().lines() {
            let code = line.split("//").next().unwrap_or("");
            for used in crate_references(code) {
                if used != owner && modules.contains(&used) {
                    edges.entry(owner.clone()).or_default().insert(used);
                }
            }
        }
    }
    edges
}

fn listed(edges: &BTreeMap<String, BTreeSet<String>>) -> String {
    let mut out = String::from(
        "# Which tmuxy-core module uses which (packages/tmuxy-core/tests/module_graph.rs).\n\
         # A new edge is a design change: rewrite this with\n\
         # UPDATE_GENERATED=1 cargo test -p tmuxy-core --test module_graph\n",
    );
    for (from, tos) in edges {
        for to in tos {
            out.push_str(&format!("{from} -> {to}\n"));
        }
    }
    out
}

/// A cycle among the modules, as its members in order, if there is one.
fn a_cycle(edges: &BTreeMap<String, BTreeSet<String>>) -> Option<Vec<String>> {
    fn visit(
        node: &str,
        edges: &BTreeMap<String, BTreeSet<String>>,
        path: &mut Vec<String>,
        done: &mut BTreeSet<String>,
    ) -> Option<Vec<String>> {
        if let Some(at) = path.iter().position(|n| n == node) {
            return Some(path[at..].to_vec());
        }
        if done.contains(node) {
            return None;
        }
        path.push(node.to_string());
        for next in edges.get(node).into_iter().flatten() {
            if let Some(cycle) = visit(next, edges, path, done) {
                return Some(cycle);
            }
        }
        path.pop();
        done.insert(node.to_string());
        None
    }
    let mut done = BTreeSet::new();
    edges
        .keys()
        .find_map(|start| visit(start, edges, &mut Vec::new(), &mut done))
}

#[test]
fn the_module_graph_is_the_one_on_record() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/generated/module_graph.txt");
    let generated = listed(&graph());
    if std::env::var_os("UPDATE_GENERATED").is_some() {
        std::fs::write(&path, generated).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    let lines = |text: &str| -> BTreeSet<String> {
        text.lines()
            .filter(|l| !l.starts_with('#'))
            .map(String::from)
            .collect()
    };
    let (now, before) = (lines(&generated), lines(&committed));
    let added: Vec<_> = now.difference(&before).collect();
    let removed: Vec<_> = before.difference(&now).collect();
    assert!(
        added.is_empty() && removed.is_empty(),
        "tmuxy-core's module graph changed: new {added:?}, gone {removed:?}. A new edge is a \
         design change: if it is meant, rewrite the list with UPDATE_GENERATED=1 cargo test -p \
         tmuxy-core --test module_graph and say why in the commit."
    );
}

#[test]
fn no_two_modules_use_each_other() {
    let cycle = a_cycle(&graph());
    assert!(
        cycle.is_none(),
        "tmuxy-core's modules use each other round a loop: {cycle:?}. Move what they share \
         into a module both use, or merge them."
    );
}

#[test]
fn a_reference_is_read_by_its_first_segment_grouped_or_not() {
    assert_eq!(
        crate_references("use crate::paths::{self, Layout}; let x = crate::session::name();"),
        ["paths", "session"]
    );
    assert_eq!(
        crate_references("use crate::{argv, control_mode::{query, Tx}, ids::PaneId};"),
        ["argv", "control_mode", "ids"]
    );
    let looped = BTreeMap::from([
        ("a".to_string(), BTreeSet::from(["b".to_string()])),
        ("b".to_string(), BTreeSet::from(["a".to_string()])),
    ]);
    assert_eq!(
        a_cycle(&looped),
        Some(vec!["a".to_string(), "b".to_string()])
    );
}
