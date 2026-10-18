//! Theme operations shared by both transports.
//!
//! The SSE server and the Tauri app used to carry near-verbatim copies of
//! these handlers — which had already drifted (one used the
//! `tmux_options::THEME` constants, the other hardcoded `"@tmuxy-theme"`
//! strings). One implementation over the monitor's command channel keeps them
//! in lockstep, and keeps every read and write on the control-mode connection
//! (an external `tmux` while it is attached can crash tmux 3.5a).

use crate::constants::tmux_options;
use crate::control_mode::MonitorCommandSender;
use crate::executor::tmux_quote;
use crate::session;
use crate::transport::query;
use crate::CommandError;

/// Fallbacks when the tmux options are unset (fresh server, never themed).
const DEFAULT_THEME: &str = "default";
const DEFAULT_MODE: &str = "dark";

/// How much of each surface's background the UI paints, plus the native blur
/// flag — the `@tmuxy-*` appearance options from `tmuxy.conf`, read the same
/// way on every platform. Alphas are clamped to 0.0–1.0; what shows through
/// the remainder is the platform's business (the blurred desktop on macOS,
/// the desktop on Linux, the theme bg in a browser).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    /// Window chrome: title bar, sidebar, the gaps between panes.
    pub opacity: f64,
    pub active_pane_opacity: f64,
    pub inactive_pane_opacity: f64,
    pub active_text_opacity: f64,
    pub inactive_text_opacity: f64,
    pub blur: bool,
    /// Layout animations on or off (`@tmuxy-animations`).
    pub animations: bool,
    /// Whether the cursor blinks when the application has not asked for a
    /// particular cursor (`@tmuxy-cursor-blink`).
    pub cursor_blink: bool,
    /// Whether a send into another pane asks first (`@tmuxy-send-ask`).
    pub send_ask: bool,
    /// Cards per row in the "all tabs" view (`@tmuxy-tab-overview-cols`).
    pub tab_overview_cols: u32,
    /// Two-finger slide left/right switches tabs (`@tmuxy-gesture-swipe-tabs`).
    pub gesture_swipe_tabs: bool,
    /// Pinch out zooms a pane, pinch in unzooms it (`@tmuxy-gesture-pinch-zoom`).
    pub gesture_pinch_zoom: bool,
    /// Pinch in on an unzoomed tab opens the "all tabs" view
    /// (`@tmuxy-gesture-pinch-overview`).
    pub gesture_pinch_overview: bool,
    /// The desktop app draws its menus natively (`@tmuxy-native-menus`).
    pub native_menus: bool,
}

/// Widest "all tabs" grid the option accepts; past this a card is too small
/// to read.
const MAX_TAB_OVERVIEW_COLS: u32 = 12;

impl Default for Appearance {
    fn default() -> Self {
        Self {
            opacity: 0.7,
            active_pane_opacity: 1.0,
            inactive_pane_opacity: 0.7,
            active_text_opacity: 1.0,
            inactive_text_opacity: 0.7,
            blur: true,
            animations: true,
            cursor_blink: true,
            send_ask: true,
            tab_overview_cols: 3,
            gesture_swipe_tabs: true,
            gesture_pinch_zoom: true,
            gesture_pinch_overview: true,
            native_menus: true,
        }
    }
}

/// Parse an opacity option value; anything that isn't a finite number falls
/// back to `default`, out-of-range numbers are clamped.
pub fn parse_opacity(value: &str, default: f64) -> f64 {
    value
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
        .map_or(default, |v| v.clamp(0.0, 1.0))
}

/// Parse an on/off option value (`on`/`off`, `true`/`false`, `yes`/`no`,
/// `1`/`0`); anything else falls back to `default`.
pub fn parse_flag(value: &str, default: bool) -> bool {
    match value.trim().to_ascii_lowercase().as_str() {
        "on" | "true" | "yes" | "1" => true,
        "off" | "false" | "no" | "0" => false,
        _ => default,
    }
}

/// Parse a column-count option value; anything that isn't a whole number of
/// at least 1 falls back to `default`, and counts above `max` are capped.
pub fn parse_count(value: &str, default: u32, max: u32) -> u32 {
    value
        .trim()
        .parse::<u32>()
        .ok()
        .filter(|v| *v >= 1)
        .map_or(default, |v| v.min(max))
}

/// Every option the theme settings are read from, in the order the query
/// prints them.
const SETTINGS_OPTIONS: [&str; 16] = [
    tmux_options::THEME,
    tmux_options::THEME_MODE,
    tmux_options::OPACITY,
    tmux_options::ACTIVE_PANE_OPACITY,
    tmux_options::INACTIVE_PANE_OPACITY,
    tmux_options::ACTIVE_TEXT_OPACITY,
    tmux_options::INACTIVE_TEXT_OPACITY,
    tmux_options::BLUR,
    tmux_options::ANIMATIONS,
    tmux_options::CURSOR_BLINK,
    tmux_options::SEND_ASK,
    tmux_options::TAB_OVERVIEW_COLS,
    tmux_options::GESTURE_SWIPE_TABS,
    tmux_options::GESTURE_PINCH_ZOOM,
    tmux_options::GESTURE_PINCH_OVERVIEW,
    tmux_options::NATIVE_MENUS,
];

/// The prefix of the options that each set one CSS variable on the page:
/// `@tmuxy-css-term-background '#101010'` is `--term-background: #101010`
/// applied over the theme file. One option per variable, so a script in a
/// pane can set a colour without writing a stylesheet.
pub const CSS_VAR_PREFIX: &str = tmux_options::CSS_VAR_PREFIX;

/// One command list printing every settings option as `name=value`, a line
/// each, then every global option for the `@tmuxy-css-*` ones among them.
/// Named rather than positional: an unset option prints an empty value, and
/// a blank line does not survive the control-mode reply, so the lines of a
/// positional read shifted — a fresh config read its opacity as its theme.
fn settings_query() -> String {
    SETTINGS_OPTIONS
        .iter()
        .map(|option| format!("display-message -p '{option}=#{{{option}}}'"))
        .chain(std::iter::once("show-options -g".to_string()))
        .collect::<Vec<_>>()
        .join(" ; ")
}

/// The `--name: value` pairs among `show-options -g` lines, as
/// `{ "name": "value" }` with the `--` dropped. tmux prints a value in double
/// quotes when it has to, escaping `"` and `\`. A name that could end a
/// declaration, or a value that could start another rule, is left out: the
/// client writes these into one style rule, one declaration each.
fn parse_css_vars<'a>(
    lines: impl Iterator<Item = &'a str>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut vars = serde_json::Map::new();
    for line in lines {
        let Some(rest) = line.strip_prefix(CSS_VAR_PREFIX) else {
            continue;
        };
        let (name, value) = rest.split_once(' ').unwrap_or((rest, ""));
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .map(|v| v.replace("\\\"", "\"").replace("\\\\", "\\"))
            .unwrap_or_else(|| value.to_string());
        let usable = session::is_safe_css_name(name)
            && !value.is_empty()
            && !value
                .chars()
                .any(|c| c.is_control() || matches!(c, ';' | '{' | '}'));
        if usable {
            vars.insert(name.to_string(), serde_json::Value::String(value));
        }
    }
    vars
}

/// The settings from what [`settings_query`] printed, with the defaults for
/// anything unset or malformed. Returns `{ "theme", "mode", "appearance",
/// "cssVars" }`.
fn parse_settings(output: &str) -> serde_json::Value {
    let lines: Vec<&str> = output.lines().map(str::trim).collect();
    let value = |option: &str| {
        lines
            .iter()
            .find_map(|line| line.strip_prefix(option)?.strip_prefix('='))
            .unwrap_or("")
    };
    let theme = value(tmux_options::THEME);
    let mode = value(tmux_options::THEME_MODE);
    let defaults = Appearance::default();
    let appearance = Appearance {
        opacity: parse_opacity(value(tmux_options::OPACITY), defaults.opacity),
        active_pane_opacity: parse_opacity(
            value(tmux_options::ACTIVE_PANE_OPACITY),
            defaults.active_pane_opacity,
        ),
        inactive_pane_opacity: parse_opacity(
            value(tmux_options::INACTIVE_PANE_OPACITY),
            defaults.inactive_pane_opacity,
        ),
        active_text_opacity: parse_opacity(
            value(tmux_options::ACTIVE_TEXT_OPACITY),
            defaults.active_text_opacity,
        ),
        inactive_text_opacity: parse_opacity(
            value(tmux_options::INACTIVE_TEXT_OPACITY),
            defaults.inactive_text_opacity,
        ),
        blur: parse_flag(value(tmux_options::BLUR), defaults.blur),
        animations: parse_flag(value(tmux_options::ANIMATIONS), defaults.animations),
        cursor_blink: parse_flag(value(tmux_options::CURSOR_BLINK), defaults.cursor_blink),
        send_ask: parse_flag(value(tmux_options::SEND_ASK), defaults.send_ask),
        tab_overview_cols: parse_count(
            value(tmux_options::TAB_OVERVIEW_COLS),
            defaults.tab_overview_cols,
            MAX_TAB_OVERVIEW_COLS,
        ),
        gesture_swipe_tabs: parse_flag(
            value(tmux_options::GESTURE_SWIPE_TABS),
            defaults.gesture_swipe_tabs,
        ),
        gesture_pinch_zoom: parse_flag(
            value(tmux_options::GESTURE_PINCH_ZOOM),
            defaults.gesture_pinch_zoom,
        ),
        gesture_pinch_overview: parse_flag(
            value(tmux_options::GESTURE_PINCH_OVERVIEW),
            defaults.gesture_pinch_overview,
        ),
        native_menus: parse_flag(value(tmux_options::NATIVE_MENUS), defaults.native_menus),
    };
    let css_vars = parse_css_vars(lines.iter().copied());
    serde_json::json!({
        "theme": if theme.is_empty() { DEFAULT_THEME } else { theme },
        "mode": if mode.is_empty() { DEFAULT_MODE } else { mode },
        "appearance": appearance,
        "cssVars": css_vars,
    })
}

/// Read the active theme name + mode and the appearance from tmux in one
/// round trip, applying the defaults. Returns `{ "theme", "mode",
/// "appearance" }` — the wire shape the `get_theme_settings` Tauri command,
/// the `GetThemeSettings` SSE command and the `theme-settings` push (after the
/// config is sourced) all share.
pub async fn get_theme_settings(
    tx: &MonitorCommandSender,
) -> Result<serde_json::Value, CommandError> {
    let output = query(tx, &settings_query()).await?;
    Ok(parse_settings(&output))
}

/// A value written into a control-mode command line. Quoting keeps `;` and
/// spaces literal; a control character would end the line and start another
/// command, so it is refused.
fn option_value(value: &str) -> Result<String, CommandError> {
    if value.chars().any(char::is_control) {
        return Err(CommandError::invalid(format!(
            "not a usable option value: {value:?}"
        )));
    }
    Ok(tmux_quote(value))
}

/// Set global options in one command list.
async fn set_options(
    tx: &MonitorCommandSender,
    options: &[(&str, &str)],
    what: &str,
) -> Result<(), CommandError> {
    let mut commands = Vec::with_capacity(options.len());
    for (option, value) in options {
        commands.push(format!("set-option -g {option} {}", option_value(value)?));
    }
    query(tx, &commands.join(" ; "))
        .await
        .map(|_| ())
        .map_err(|e| e.context(&format!("Failed to set {what}")))
}

/// Turn the cursor's blink on or off, and remember the choice.
///
/// The live tmux option is what the clients read; the state file is what
/// makes it survive a tmux server restart. A `@tmuxy-cursor-blink` line in
/// the user's own `tmuxy.conf` is the default this starts from — set it
/// there and the app never has to be told.
pub async fn set_cursor_blink(
    tx: &MonitorCommandSender,
    enabled: bool,
) -> Result<(), CommandError> {
    let value = if enabled { "on" } else { "off" };
    set_options(tx, &[(tmux_options::CURSOR_BLINK, value)], "cursor blink").await?;
    if let Err(e) = session::write_managed_state(None, None, Some(enabled), None, None) {
        tracing::warn!(error = %e, "could not persist the cursor blink to tmuxy.state.json");
    }
    Ok(())
}

/// Turn the question a send into another pane asks on or off, and remember
/// the choice, the way [`set_cursor_blink`] does.
pub async fn set_send_ask(tx: &MonitorCommandSender, enabled: bool) -> Result<(), CommandError> {
    let value = if enabled { "on" } else { "off" };
    set_options(tx, &[(tmux_options::SEND_ASK, value)], "send ask").await?;
    if let Err(e) = session::write_managed_state(None, None, None, Some(enabled), None) {
        tracing::warn!(error = %e, "could not persist the send ask to tmuxy.state.json");
    }
    Ok(())
}

/// Set the theme (and optionally the mode) in tmux and persist the choice so
/// it survives a tmux server restart. Persistence failure is non-fatal — the
/// live option is already set — and is logged, not returned.
pub async fn set_theme(
    tx: &MonitorCommandSender,
    name: &str,
    mode: Option<&str>,
) -> Result<(), CommandError> {
    let mut options = vec![(tmux_options::THEME, name)];
    if let Some(m) = mode {
        options.push((tmux_options::THEME_MODE, m));
    }
    set_options(tx, &options, "theme").await?;
    if let Err(e) = session::write_managed_state(Some(name), mode, None, None, None) {
        tracing::warn!(error = %e, "could not persist theme to tmuxy.state.json");
    }
    Ok(())
}

/// Set only the mode (dark/light) and persist it.
pub async fn set_theme_mode(tx: &MonitorCommandSender, mode: &str) -> Result<(), CommandError> {
    set_options(tx, &[(tmux_options::THEME_MODE, mode)], "theme mode").await?;
    if let Err(e) = session::write_managed_state(None, Some(mode), None, None, None) {
        tracing::warn!(error = %e, "could not persist theme mode to tmuxy.state.json");
    }
    Ok(())
}

/// Human-readable display name for a theme file stem:
/// `tokyo-night` → `Tokyo Night`.
pub fn display_theme_name(stem: &str) -> String {
    stem.split('-')
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Available themes as the `[{ name, displayName, modes }]` wire shape both
/// transports serve. Backed by `session::list_themes()` (the same scan the
/// native menu uses); `modes` is what each file's CSS declares a palette
/// for, so the menu can grey out a mode the theme has not got.
pub fn get_themes_list() -> serde_json::Value {
    let themes: Vec<serde_json::Value> = session::list_themes()
        .into_iter()
        .map(|name| {
            let display_name = display_theme_name(&name);
            let modes = session::resolve_user_css(&format!("themes/{name}.css"))
                .map(|css| session::theme_modes(&String::from_utf8_lossy(&css)))
                .unwrap_or_default();
            serde_json::json!({ "name": name, "displayName": display_name, "modes": modes })
        })
        .collect();
    serde_json::json!(themes)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
