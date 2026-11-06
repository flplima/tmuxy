//! `tmuxy-plugin.toml`: parsed only here, strictly.
//!
//! Unknown keys are errors (a misspelt `surfce` must not silently fall back to
//! a default), the file is capped before it is parsed, and every problem is
//! reported with the line it is on, which is what `tmuxy plugin check` prints.
//! The raw form keeps each value's span; [`parse`] validates it into a plain
//! [`Manifest`] the rest of the module uses.

use serde::{Deserialize, Serialize};
use toml::Spanned;

use super::{is_valid_name, parse_version, API_VERSION};

mod report;
pub mod sections;
mod validate;

pub use report::Diagnostic;
use report::{line_col, Report};
pub use sections::{
    Dependency, Key, KeyTable, LinkHandler, LinkMatch, Setting, SettingType, SettingValue, Theme,
};

/// Larger than any honest manifest; checked before parsing.
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;

/// A validated manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub name: String,
    pub version: String,
    pub description: String,
    pub min_tmuxy: Option<String>,
    /// `None`: every platform.
    pub platforms: Option<Vec<Platform>>,
    pub requires: Vec<String>,
    pub actions: Vec<Action>,
    pub cli: Vec<CliVerb>,
    pub link_handlers: Vec<LinkHandler>,
    pub keys: Vec<Key>,
    pub settings: Vec<Setting>,
    pub depends: Vec<Dependency>,
    pub themes: Vec<Theme>,
}

/// An `[[actions]]` entry: the unit everything else (menus, `tmuxy plugin
/// action`) points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Action {
    pub id: String,
    pub title: String,
    pub menu: Option<Menu>,
    pub surface: Surface,
    pub size: Option<Size>,
    /// argv, `command[0]` relative to the plugin's root.
    pub command: Vec<String>,
    pub platforms: Option<Vec<Platform>>,
}

/// A `[[cli]]` entry: `tmuxy plugin <verb> …`, run in the caller's shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliVerb {
    pub verb: String,
    pub description: String,
    pub command: Vec<String>,
    pub platforms: Option<Vec<Platform>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Linux,
    Macos,
}

impl Platform {
    pub fn as_str(self) -> &'static str {
        match self {
            Platform::Linux => "linux",
            Platform::Macos => "macos",
        }
    }
}

/// Which menu offers an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Menu {
    /// The app menu's Plugins submenu; acts on the active pane.
    App,
    /// A pane's menu; acts on that pane.
    Pane,
    /// The menu over selected text; the text reaches the plugin in a file.
    Selection,
}

impl Menu {
    pub fn as_str(self) -> &'static str {
        match self {
            Menu::App => "app",
            Menu::Pane => "pane",
            Menu::Selection => "selection",
        }
    }
}

/// Where an action's command runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Surface {
    /// A pane split beside the target.
    #[default]
    Split,
    /// A tab of its own, brought to the front.
    Tab,
    /// A float over the target's tab.
    Float,
    /// A float without a header over a dimmed tab; it closes with its process.
    Popup,
    /// A split, zoomed to fill the tab.
    Zoomed,
}

impl Surface {
    pub fn as_str(self) -> &'static str {
        match self {
            Surface::Split => "split",
            Surface::Tab => "tab",
            Surface::Float => "float",
            Surface::Popup => "popup",
            Surface::Zoomed => "zoomed",
        }
    }

    /// Whether `size` means anything for it.
    pub fn is_floating(self) -> bool {
        matches!(self, Surface::Float | Surface::Popup)
    }
}

/// A float's size: cells, or a percentage of the tab it floats over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Size {
    pub width: Option<Dim>,
    pub height: Option<Dim>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dim {
    Cells(u32),
    Percent(u32),
}

impl Dim {
    /// The cells this is out of `total`, at least one.
    pub fn resolve(self, total: u32) -> u32 {
        match self {
            Dim::Cells(n) => n.max(1),
            Dim::Percent(p) => (total.saturating_mul(p) / 100).max(1),
        }
    }

    fn describe(self) -> String {
        match self {
            Dim::Cells(n) => n.to_string(),
            Dim::Percent(p) => format!("{p}%"),
        }
    }
}

impl Size {
    pub fn describe(&self) -> String {
        let part = |d: Option<Dim>| d.map(Dim::describe).unwrap_or_else(|| "default".into());
        format!("{}x{}", part(self.width), part(self.height))
    }
}

// ── The raw form ────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawManifest {
    plugin: Spanned<RawPlugin>,
    #[serde(default)]
    actions: Vec<Spanned<RawAction>>,
    #[serde(default)]
    cli: Vec<Spanned<RawCli>>,
    #[serde(default)]
    link_handlers: Vec<Spanned<validate::RawLink>>,
    #[serde(default)]
    keys: Vec<Spanned<validate::RawKey>>,
    #[serde(default)]
    settings: Vec<Spanned<validate::RawSetting>>,
    #[serde(default)]
    themes: Vec<Spanned<validate::RawTheme>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPlugin {
    api: Spanned<u32>,
    #[serde(default)]
    min_tmuxy: Option<Spanned<String>>,
    name: Spanned<String>,
    version: Spanned<String>,
    #[serde(default)]
    description: Option<Spanned<String>>,
    #[serde(default)]
    platforms: Option<Spanned<Vec<Platform>>>,
    #[serde(default)]
    requires: Option<Spanned<Vec<String>>>,
    #[serde(default)]
    depends: Option<Spanned<Vec<validate::RawDependency>>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAction {
    id: Spanned<String>,
    title: Spanned<String>,
    #[serde(default)]
    menu: Option<Menu>,
    #[serde(default)]
    surface: Surface,
    #[serde(default)]
    size: Option<Spanned<RawSize>>,
    command: Spanned<Vec<String>>,
    #[serde(default)]
    platforms: Option<Vec<Platform>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSize {
    #[serde(default)]
    width: Option<RawDim>,
    #[serde(default)]
    height: Option<RawDim>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawDim {
    Cells(i64),
    Text(String),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCli {
    verb: Spanned<String>,
    #[serde(default)]
    description: Option<String>,
    command: Spanned<Vec<String>>,
    #[serde(default)]
    platforms: Option<Vec<Platform>>,
}

/// Whether `text` is plain text for a menu label: no control characters.
fn is_label(text: &str) -> bool {
    !text.trim().is_empty() && text.chars().count() <= 80 && !text.chars().any(char::is_control)
}

/// A command's program: a relative path inside the plugin, no `..`.
fn command_problem(command: &[String]) -> Option<String> {
    let Some(program) = command.first() else {
        return Some("command is empty; it is an argv, e.g. [\"bin/run\"]".into());
    };
    if command.iter().any(|a| a.contains('\0')) {
        return Some("command contains a NUL byte".into());
    }
    let path = std::path::Path::new(program);
    if program.is_empty() || path.is_absolute() {
        return Some(format!(
            "command[0] {program:?} must be a path inside the plugin (e.g. \"bin/run\"), not absolute"
        ));
    }
    if path
        .components()
        .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Some(format!(
            "command[0] {program:?} must stay inside the plugin: no `..` or `.` components"
        ));
    }
    None
}

fn parse_dim(raw: &RawDim) -> Result<Dim, String> {
    match raw {
        RawDim::Cells(n) if (1..=1000).contains(n) => Ok(Dim::Cells(*n as u32)),
        RawDim::Cells(n) => Err(format!("{n} cells is out of range (1 to 1000)")),
        RawDim::Text(text) => {
            let pct = text
                .strip_suffix('%')
                .and_then(|n| n.trim().parse::<u32>().ok())
                .filter(|p| (1..=100).contains(p));
            pct.map(Dim::Percent).ok_or_else(|| {
                format!("{text:?} is neither a number of cells nor \"1%\" to \"100%\"")
            })
        }
    }
}

/// Parse and validate a manifest. `Err` holds every problem found, so one
/// `tmuxy plugin check` run reports them all.
pub fn parse(text: &str) -> Result<Manifest, Vec<Diagnostic>> {
    if text.len() > MAX_MANIFEST_BYTES {
        return Err(vec![Diagnostic {
            line: None,
            column: None,
            message: format!(
                "manifest is {} bytes; the limit is {MAX_MANIFEST_BYTES}",
                text.len()
            ),
        }]);
    }
    let raw: RawManifest = match toml::from_str(text) {
        Ok(raw) => raw,
        Err(e) => {
            let (line, column) = e
                .span()
                .map(|span| {
                    let (l, c) = line_col(text, span.start);
                    (Some(l), Some(c))
                })
                .unwrap_or((None, None));
            return Err(vec![Diagnostic {
                line,
                column,
                message: e.message().trim().to_string(),
            }]);
        }
    };
    let mut report = Report {
        text,
        diagnostics: Vec::new(),
    };
    let manifest = validate(raw, &mut report);
    if report.diagnostics.is_empty() {
        Ok(manifest)
    } else {
        Err(report.diagnostics)
    }
}

fn validate(raw: RawManifest, report: &mut Report<'_>) -> Manifest {
    let plugin_span = raw.plugin.span();
    let plugin = raw.plugin.into_inner();

    if *plugin.api.get_ref() != API_VERSION {
        report.at(
            plugin.api.span(),
            format!(
                "api = {} is not supported; this tmuxy implements api = {API_VERSION}",
                plugin.api.get_ref()
            ),
        );
    }
    if let Some(min) = &plugin.min_tmuxy {
        if parse_version(min.get_ref()).is_none() {
            report.at(
                min.span(),
                format!("min_tmuxy {:?} is not a version (x.y.z)", min.get_ref()),
            );
        }
    }
    if !is_valid_name(plugin.name.get_ref()) {
        report.at(
            plugin.name.span(),
            format!(
                "name {:?}: use lowercase letters, digits and '-' (at most 40), e.g. \"chrome-devtools\"",
                plugin.name.get_ref()
            ),
        );
    }
    if plugin.version.get_ref().trim().is_empty()
        || plugin.version.get_ref().chars().any(char::is_control)
    {
        report.at(plugin.version.span(), "version must be non-empty text");
    }
    if let Some(description) = &plugin.description {
        if description
            .get_ref()
            .chars()
            .any(|c| c.is_control() && c != '\n')
        {
            report.at(
                description.span(),
                "description contains control characters",
            );
        }
    }
    let requires = plugin
        .requires
        .map(|r| {
            let span = r.span();
            let list = r.into_inner();
            for name in &list {
                let ok = !name.is_empty()
                    && name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b));
                if !ok {
                    report.at(
                        span.clone(),
                        format!("requires: {name:?} is not a command name"),
                    );
                }
            }
            list
        })
        .unwrap_or_default();
    if let Some(platforms) = &plugin.platforms {
        if platforms.get_ref().is_empty() {
            report.at(
                platforms.span(),
                "platforms is empty; leave it out for every platform",
            );
        }
    }

    let mut actions = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    for raw_action in raw.actions {
        let action_span = raw_action.span();
        let a = raw_action.into_inner();
        let id = a.id.get_ref().clone();
        if !is_valid_name(&id) {
            report.at(
                a.id.span(),
                format!("action id {id:?}: use lowercase letters, digits and '-' (at most 40)"),
            );
        } else if !seen_ids.insert(id.clone()) {
            report.at(a.id.span(), format!("action id {id:?} is declared twice"));
        }
        if !is_label(a.title.get_ref()) {
            report.at(
                a.title.span(),
                "title must be one line of text, at most 80 characters",
            );
        }
        if let Some(problem) = command_problem(a.command.get_ref()) {
            report.at(a.command.span(), problem);
        }
        let size = a.size.map(|s| {
            let span = s.span();
            let s = s.into_inner();
            if !a.surface.is_floating() {
                report.at(
                    span.clone(),
                    format!(
                        "size applies to the float and popup surfaces, not {}",
                        a.surface.as_str()
                    ),
                );
            }
            let mut dim = |raw: Option<RawDim>| match raw.as_ref().map(parse_dim) {
                None => None,
                Some(Ok(d)) => Some(d),
                Some(Err(message)) => {
                    report.at(span.clone(), format!("size: {message}"));
                    None
                }
            };
            Size {
                width: dim(s.width),
                height: dim(s.height),
            }
        });
        if a.platforms.as_ref().is_some_and(Vec::is_empty) {
            report.at(
                action_span,
                "platforms is empty; leave it out for every platform",
            );
        }
        actions.push(Action {
            id,
            title: a.title.into_inner(),
            menu: a.menu,
            surface: a.surface,
            size,
            command: a.command.into_inner(),
            platforms: a.platforms,
        });
    }

    let mut cli = Vec::new();
    let mut seen_verbs = std::collections::HashSet::new();
    for raw_cli in raw.cli {
        let cli_span = raw_cli.span();
        let c = raw_cli.into_inner();
        let verb = c.verb.get_ref().clone();
        let starts_with_letter = verb.bytes().next().is_some_and(|b| b.is_ascii_lowercase());
        if !is_valid_name(&verb) || !starts_with_letter {
            report.at(
                c.verb.span(),
                format!(
                    "verb {verb:?}: a lowercase word starting with a letter (letters, digits, '-')"
                ),
            );
        } else if !seen_verbs.insert(verb.clone()) {
            report.at(c.verb.span(), format!("verb {verb:?} is declared twice"));
        }
        if let Some(problem) = command_problem(c.command.get_ref()) {
            report.at(c.command.span(), problem);
        }
        if c.description
            .as_deref()
            .is_some_and(|d| d.chars().any(char::is_control))
        {
            report.at(cli_span.clone(), "description must be one line of text");
        }
        if c.platforms.as_ref().is_some_and(Vec::is_empty) {
            report.at(
                cli_span,
                "platforms is empty; leave it out for every platform",
            );
        }
        cli.push(CliVerb {
            verb,
            description: c.description.unwrap_or_default(),
            command: c.command.into_inner(),
            platforms: c.platforms,
        });
    }

    let action_ids: std::collections::HashSet<String> =
        actions.iter().map(|a| a.id.clone()).collect();
    let link_handlers = validate::links(raw.link_handlers, &action_ids, report);
    let keys = validate::keys(raw.keys, &action_ids, report);
    let settings = validate::settings(raw.settings, report);
    let depends = validate::depends(plugin.depends, plugin.name.get_ref(), report);
    let themes = validate::themes(raw.themes, report);
    if actions.is_empty() && cli.is_empty() && themes.is_empty() {
        report.at(
            plugin_span,
            "the plugin declares nothing: add an [[actions]], [[cli]] or [[themes]] entry",
        );
    }

    Manifest {
        name: plugin.name.into_inner(),
        version: plugin.version.into_inner(),
        description: plugin
            .description
            .map(Spanned::into_inner)
            .unwrap_or_default(),
        min_tmuxy: plugin.min_tmuxy.map(Spanned::into_inner),
        platforms: plugin.platforms.map(Spanned::into_inner),
        requires,
        actions,
        cli,
        link_handlers,
        keys,
        settings,
        depends,
        themes,
    }
}

impl Manifest {
    /// Read and parse the manifest at `root`.
    pub fn load(root: &std::path::Path) -> Result<Manifest, Vec<Diagnostic>> {
        let path = root.join(super::MANIFEST_FILE);
        let text = read_capped(&path).map_err(|message| {
            vec![Diagnostic {
                line: None,
                column: None,
                message,
            }]
        })?;
        parse(&text)
    }

    /// What the plugin can do, as the index lists it.
    pub fn capabilities(&self) -> Vec<&'static str> {
        [
            ("actions", !self.actions.is_empty()),
            ("cli", !self.cli.is_empty()),
            ("links", !self.link_handlers.is_empty()),
            ("keys", !self.keys.is_empty()),
            ("settings", !self.settings.is_empty()),
            ("themes", !self.themes.is_empty()),
            ("depends", !self.depends.is_empty()),
        ]
        .into_iter()
        .filter_map(|(name, has)| has.then_some(name))
        .collect()
    }

    /// Whether the plugin as a whole is for this platform.
    pub fn runs_here(&self) -> bool {
        runs_on(&self.platforms)
    }

    /// The actions that apply on this platform.
    pub fn actions_here(&self) -> impl Iterator<Item = &Action> {
        self.actions.iter().filter(|a| runs_on(&a.platforms))
    }

    /// The verbs that apply on this platform.
    pub fn cli_here(&self) -> impl Iterator<Item = &CliVerb> {
        self.cli.iter().filter(|c| runs_on(&c.platforms))
    }
}

/// Whether a `platforms` list includes this platform (`None`: every one).
pub fn runs_on(platforms: &Option<Vec<Platform>>) -> bool {
    platforms
        .as_ref()
        .is_none_or(|list| list.contains(&super::current_platform()))
}

/// The manifest's text, refusing a file larger than the cap before reading
/// it whole, and anything but a regular file.
fn read_capped(path: &std::path::Path) -> Result<String, String> {
    use std::io::Read;
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    let mut text = String::new();
    std::fs::File::open(path)
        .and_then(|f| {
            f.take(MAX_MANIFEST_BYTES as u64 + 1)
                .read_to_string(&mut text)
        })
        .map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(text)
}
