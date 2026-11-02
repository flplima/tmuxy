//! `list`, `log`, `check` and `new`: reading what is installed, and helping
//! write a plugin.

use std::path::Path;

use tmuxy_core::plugins::manifest::Manifest;
use tmuxy_core::plugins::registry::{self, Kind, Registry};
use tmuxy_core::plugins::{
    log, satisfies_min_tmuxy, scaffold, Dirs, PluginError, RESERVED_VERBS, USER_PLUGIN,
};

use super::{say, usage, Failure, Outcome};

pub(super) fn list(dirs: &Dirs, json: bool) -> Outcome {
    let registry = Registry::load(dirs)?;
    let mut rows = Vec::new();
    for p in &registry.plugins {
        let (source, commit) = match &p.kind {
            Kind::Repo { slug, sha } => (slug.clone(), sha[..12].to_string()),
            Kind::Linked => (p.root.display().to_string(), "dev".to_string()),
            Kind::User => (p.root.display().to_string(), "user".to_string()),
        };
        rows.push(serde_json::json!({
            "name": p.name,
            "version": p.manifest.version,
            "source": source,
            "commit": commit,
            "actions": p.manifest.actions.iter().map(|a| format!("{}:{}", p.name, a.id)).collect::<Vec<_>>(),
            "verbs": p.manifest.cli.iter().map(|c| c.verb.clone()).collect::<Vec<_>>(),
            "shadowed": registry.shadowed(p),
        }));
    }
    for b in &registry.broken {
        rows.push(serde_json::json!({
            "name": b.name,
            "source": b.source,
            "broken": b.reason,
        }));
    }
    if !json {
        if rows.is_empty() {
            println!("No plugins installed. `tmuxy plugin install owner/repo` adds one.");
        }
        for row in &rows {
            let name = row["name"].as_str().unwrap_or_default();
            if let Some(reason) = row["broken"].as_str() {
                println!("{name:<20} BROKEN: {reason}");
                continue;
            }
            let verbs: Vec<String> = row["verbs"]
                .as_array()
                .map(|v| {
                    v.iter()
                        .filter_map(|s| s.as_str())
                        .map(|s| format!("tmuxy plugin {s}"))
                        .collect()
                })
                .unwrap_or_default();
            println!(
                "{name:<20} {:<10} {:<12} {}",
                row["version"].as_str().unwrap_or_default(),
                row["commit"].as_str().unwrap_or_default(),
                row["source"].as_str().unwrap_or_default(),
            );
            for action in row["actions"].as_array().into_iter().flatten() {
                println!("    action  {}", action.as_str().unwrap_or_default());
            }
            for verb in &verbs {
                println!("    verb    {verb}");
            }
            for shadowed in row["shadowed"].as_array().into_iter().flatten() {
                let verb = shadowed["verb"].as_str().unwrap_or_default();
                match shadowed["by"].as_str() {
                    Some(by) => println!(
                        "    SHADOWED: `tmuxy plugin {verb}` runs plugin {by:?}'s verb, which comes first"
                    ),
                    None => println!(
                        "    SHADOWED: `tmuxy plugin {verb}` is now a built-in command, which wins"
                    ),
                }
            }
        }
    }
    Ok(serde_json::json!({ "plugins": rows }))
}

pub(super) fn show_log(dirs: &Dirs, name: &str, follow: bool) -> Outcome {
    if !tmuxy_core::plugins::is_valid_name(name) {
        return Err(usage(format!("{name:?} is not a plugin name")));
    }
    let path = log::path(dirs, name);
    let mut offset = 0u64;
    loop {
        use std::io::{Read, Seek};
        if let Ok(mut file) = std::fs::File::open(&path) {
            let len = file.metadata().map(|m| m.len()).unwrap_or(0);
            if len < offset {
                offset = 0; // rotated
            }
            let _ = file.seek(std::io::SeekFrom::Start(offset));
            let mut text = String::new();
            let _ = file.read_to_string(&mut text);
            offset += text.len() as u64;
            print!("{text}");
        } else if !follow {
            return Err(PluginError::NotFound(format!("plugin {name:?} has no log yet")).into());
        }
        if !follow {
            return Ok(serde_json::Value::Null);
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

pub(super) fn check(dir: &Path, json: bool) -> Outcome {
    let shown = dir
        .join(tmuxy_core::plugins::MANIFEST_FILE)
        .display()
        .to_string();
    let m = match Manifest::load(dir) {
        Ok(m) => m,
        Err(diags) => {
            return Err(Failure {
                code: 1,
                message: diags
                    .iter()
                    .map(|d| d.render(&shown))
                    .collect::<Vec<_>>()
                    .join("\n"),
            })
        }
    };
    let mut problems = Vec::new();
    let commands = m
        .actions
        .iter()
        .map(|a| (format!("action {}", a.id), &a.command))
        .chain(
            m.cli
                .iter()
                .map(|c| (format!("verb {}", c.verb), &c.command)),
        );
    for (what, command) in commands {
        if let Err(e) = registry::resolve_command(dir, command) {
            problems.push(format!("{shown}: {what}: {e}"));
        }
    }
    let installed = Registry::load(&Dirs::current()).unwrap_or_default();
    for c in &m.cli {
        if let Some((other, _)) = installed.verb(&c.verb).filter(|(p, _)| p.name != m.name) {
            problems.push(format!(
                "{shown}: verb {:?} is already plugin {:?}'s",
                c.verb, other.name
            ));
        }
        if RESERVED_VERBS.contains(&c.verb.as_str()) {
            problems.push(format!(
                "{shown}: verb {:?} is a `tmuxy plugin` command",
                c.verb
            ));
        }
    }
    if m.name == USER_PLUGIN
        && dir.canonicalize().ok() != tmuxy_core::session::config_dir().canonicalize().ok()
    {
        problems.push(format!(
            "{shown}: name {USER_PLUGIN:?} is reserved for your own config dir's manifest"
        ));
    }
    if let Some(min) = &m.min_tmuxy {
        if !satisfies_min_tmuxy(min) {
            problems.push(format!(
                "{shown}: needs tmuxy {min}; this is {}",
                tmuxy_core::plugins::TMUXY_VERSION
            ));
        }
    }
    if !problems.is_empty() {
        return Err(Failure {
            code: 1,
            message: problems.join("\n"),
        });
    }
    say(
        json,
        format!(
            "ok: {} {} ({} actions, {} verbs)",
            m.name,
            m.version,
            m.actions.len(),
            m.cli.len()
        ),
    );
    Ok(serde_json::json!({ "name": m.name, "version": m.version }))
}

pub(super) fn new(name: &str, json: bool) -> Outcome {
    let cwd = std::env::current_dir()
        .map_err(|e| Failure::from(PluginError::io("reading the cwd", e)))?;
    let dir = scaffold::create(&cwd, name)?;
    say(json, format!("created {}", dir.display()));
    say(
        json,
        format!(
            "try it:  tmuxy plugin install --path {} && tmuxy plugin action {name}:hello",
            dir.display()
        ),
    );
    Ok(serde_json::json!({ "path": dir }))
}
