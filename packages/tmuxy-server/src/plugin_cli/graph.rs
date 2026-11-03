//! `depends`: the plugins a plugin needs, installed with it.
//!
//! Every dependency not installed yet is fetched and checked like any
//! install, its own dependencies too, and all of them go through the one
//! gate with the plugin that asked. One already installed must come from the
//! source the manifest names (a name taken by another repository is a
//! mismatch, not a match), and a plugin that needs itself through a chain is
//! refused.

use std::path::PathBuf;

use tmuxy_core::plugins::lockfile::{Entry, Lockfile};
use tmuxy_core::plugins::manifest::Manifest;
use tmuxy_core::plugins::registry::{Kind, Registry};
use tmuxy_core::plugins::source::{self, RepoSource};
use tmuxy_core::plugins::{fetch, Dirs};

use super::gate::Subject;
use super::install::{admissible, commit_checkout, load_manifest, stage};
use super::Failure;

/// A dependency fetched into staging, checked, not installed yet.
pub(super) struct Staged {
    pub source: RepoSource,
    pub slug: String,
    pub sha: String,
    pub staging: PathBuf,
    pub manifest: Manifest,
}

impl Staged {
    pub fn subject(&self) -> Subject<'_> {
        Subject {
            manifest: &self.manifest,
            source: &self.slug,
            sha: Some(&self.sha),
            previous: None,
        }
    }
}

fn refuse(message: String) -> Failure {
    Failure { code: 1, message }
}

/// The dependencies `manifest` brings that are not installed, deepest first,
/// appended to `out`. `chain` is the path from the plugin installed to here.
pub(super) fn resolve(
    dirs: &Dirs,
    registry: &Registry,
    manifest: &Manifest,
    chain: &mut Vec<String>,
    out: &mut Vec<Staged>,
) -> Result<(), Failure> {
    for dep in &manifest.depends {
        if chain.contains(&dep.name) {
            return Err(refuse(format!(
                "dependency cycle: {} -> {}",
                chain.join(" -> "),
                dep.name
            )));
        }
        let wanted = source::parse_repo(&dep.source)?;
        if let Some(installed) = registry.get(&dep.name) {
            match &installed.kind {
                Kind::Repo { slug, .. } if *slug == wanted.slug() => continue,
                Kind::Linked => continue,
                _ => {
                    return Err(refuse(format!(
                        "{} needs {:?} from {}, but the {:?} installed comes from elsewhere",
                        manifest.name, dep.name, dep.source, dep.name
                    )))
                }
            }
        }
        if let Some(broken) = registry.broken.iter().find(|b| b.name == dep.name) {
            return Err(refuse(format!(
                "{} needs {:?}, which plugins.json lists but cannot be loaded ({}); `tmuxy plugin install` with no argument fetches what plugins.json lists",
                manifest.name, dep.name, broken.reason
            )));
        }
        if let Some(staged) = out.iter().find(|s| s.manifest.name == dep.name) {
            if staged.slug != wanted.slug() {
                return Err(refuse(format!(
                    "{:?} is wanted from both {} and {}",
                    dep.name, staged.slug, dep.source
                )));
            }
            continue;
        }
        let mut src = wanted;
        src.git_ref = dep.git_ref.clone();
        let sha = fetch::resolve_ref(&src.url(), src.git_ref.as_deref())?;
        let (staging, root) = stage(dirs, &src, &sha)?;
        let checked = load_manifest(&root).and_then(|m| {
            if m.name != dep.name {
                return Err(refuse(format!(
                    "{} names itself {:?}, but {} depends on it as {:?}",
                    dep.source, m.name, manifest.name, dep.name
                )));
            }
            admissible(registry, &m, &root, None).map(|()| m)
        });
        let dep_manifest = match checked {
            Ok(m) => m,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(e);
            }
        };
        chain.push(dep.name.clone());
        let nested = resolve(dirs, registry, &dep_manifest, chain, out);
        chain.pop();
        let slug = src.slug();
        // Deepest first: a dependency is installed before what needs it.
        out.push(Staged {
            source: src,
            slug,
            sha,
            staging,
            manifest: dep_manifest,
        });
        nested?;
    }
    Ok(())
}

/// No two plugins of one install may claim the same verb.
pub(super) fn verbs_unique(manifests: &[&Manifest]) -> Result<(), Failure> {
    let mut seen = std::collections::HashMap::new();
    for m in manifests {
        for c in &m.cli {
            if let Some(other) = seen.insert(c.verb.clone(), m.name.clone()) {
                return Err(refuse(format!(
                    "verb {:?} is both {other:?}'s and {:?}'s",
                    c.verb, m.name
                )));
            }
        }
    }
    Ok(())
}

pub(super) fn discard(staged: &[Staged]) {
    for s in staged {
        let _ = std::fs::remove_dir_all(&s.staging);
    }
}

/// Move every staged dependency into place and pin it in the lockfile.
pub(super) fn commit(dirs: &Dirs, staged: Vec<Staged>, lock: &mut Lockfile) -> Result<(), Failure> {
    for s in staged {
        commit_checkout(dirs, &s.staging, &s.manifest.name, &s.sha)?;
        lock.upsert(Entry::from_repo(&s.manifest.name, &s.source, &s.sha));
    }
    Ok(())
}

/// The installed plugins that need `name`, directly or through others.
pub(super) fn dependents(registry: &Registry, name: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut queue = vec![name.to_string()];
    while let Some(current) = queue.pop() {
        for p in &registry.plugins {
            let needs = p.manifest.depends.iter().any(|d| d.name == current);
            if needs && !found.contains(&p.name) && p.name != name {
                found.push(p.name.clone());
                queue.push(p.name.clone());
            }
        }
    }
    found
}
