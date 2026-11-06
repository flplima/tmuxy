//! A plugin's settings: the `[[settings]]` schema in its manifest, the
//! values in `TMUXY_PLUGIN_CONFIG_DIR/settings.toml` (owner-only), set with
//! `tmuxy plugin config`.
//!
//! They replace the `@tmuxy-<plugin>-*` tmux options a plugin would
//! otherwise use: every process with the socket reads those, a poor place
//! for a token. A `secret = true` setting never leaves the file through
//! tmuxy: it is left out of the context JSON, the log and every listing,
//! and the plugin reads it from the file itself.

use std::path::PathBuf;

use super::manifest::{Setting, SettingValue};
use super::registry::Installed;
use super::{PluginError, Result};
use crate::paths::Layout;

/// The file, `<config_dir>/plugins/<name>/settings.toml`.
pub fn path(dirs: &Layout, plugin: &str) -> PathBuf {
    dirs.plugin_config(plugin).join("settings.toml")
}

/// The file's table: empty when there is none, an error when it does not
/// read or parse, so a `set` never rewrites a file it could not read (and
/// drops every other setting, secrets included).
pub fn read_table(dirs: &Layout, plugin: &str) -> Result<toml::Table> {
    let file = path(dirs, plugin);
    match std::fs::read_to_string(&file) {
        Ok(text) => text
            .parse::<toml::Table>()
            .map_err(|e| PluginError::Invalid(format!("{}: {e}", file.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(toml::Table::new()),
        Err(e) => Err(PluginError::io(format!("reading {}", file.display()), e)),
    }
}

/// One setting as it stands: what the file says (when it says something of
/// the right type), and what is in force (that, else the default).
#[derive(Debug, Clone)]
pub struct Current<'a> {
    pub setting: &'a Setting,
    pub set: Option<SettingValue>,
    pub value: Option<SettingValue>,
}

/// Every setting of `plugin`, in manifest order.
pub fn current<'a>(dirs: &Layout, plugin: &'a Installed) -> Result<Vec<Current<'a>>> {
    let table = read_table(dirs, &plugin.name)?;
    Ok(plugin
        .manifest
        .settings
        .iter()
        .map(|setting| {
            let set = table.get(&setting.key).and_then(|v| setting.kind.accept(v));
            let value = set.clone().or_else(|| setting.default.clone());
            Current {
                setting,
                set,
                value,
            }
        })
        .collect())
}

/// `settings` in the context JSON: every value in force but the secrets.
pub fn context_values(dirs: &Layout, plugin: &Installed) -> Result<serde_json::Value> {
    let map: serde_json::Map<String, serde_json::Value> = current(dirs, plugin)?
        .into_iter()
        .filter(|c| !c.setting.secret)
        .filter_map(|c| {
            let value = serde_json::to_value(c.value?).ok()?;
            Some((c.setting.key.clone(), value))
        })
        .collect();
    Ok(serde_json::Value::Object(map))
}

fn setting<'a>(plugin: &'a Installed, key: &str) -> Result<&'a Setting> {
    plugin
        .manifest
        .settings
        .iter()
        .find(|s| s.key == key)
        .ok_or_else(|| {
            PluginError::NotFound(format!("plugin {:?} has no setting {key:?}", plugin.name))
        })
}

fn write_table(dirs: &Layout, plugin: &str, table: &toml::Table) -> Result<()> {
    super::private_dir(&dirs.plugin_config(plugin))?;
    let text = toml::to_string(table).map_err(|e| PluginError::Invalid(e.to_string()))?;
    let file = path(dirs, plugin);
    crate::private_files::replace(&file, text)
        .map_err(|e| PluginError::io(format!("writing {}", file.display()), e))
}

/// Set `key` from its text form, checked against its type.
pub fn set(dirs: &Layout, plugin: &Installed, key: &str, text: &str) -> Result<SettingValue> {
    let setting = setting(plugin, key)?;
    let value = setting
        .kind
        .parse(text)
        .map_err(|why| PluginError::Invalid(format!("{key}: {why}")))?;
    let mut table = read_table(dirs, &plugin.name)?;
    table.insert(key.to_string(), value.to_toml());
    write_table(dirs, &plugin.name, &table)?;
    Ok(value)
}

/// Remove `key` from the file: its default is in force again.
pub fn unset(dirs: &Layout, plugin: &Installed, key: &str) -> Result<()> {
    setting(plugin, key)?;
    let mut table = read_table(dirs, &plugin.name)?;
    table.remove(key);
    write_table(dirs, &plugin.name, &table)
}

/// How a value is shown: a secret only as whether it is set.
pub fn shown(current: &Current<'_>) -> String {
    if current.setting.secret {
        return if current.set.as_ref().is_some_and(|v| v.display() != "") {
            "set".into()
        } else {
            "empty".into()
        };
    }
    current
        .value
        .as_ref()
        .map(SettingValue::display)
        .unwrap_or_default()
}
