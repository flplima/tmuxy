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
    /// Cards per row in the "all tabs" view (`@tmuxy-tab-overview-cols`).
    pub tab_overview_cols: u32,
    /// Two-finger slide left/right switches tabs (`@tmuxy-gesture-swipe-tabs`).
    pub gesture_swipe_tabs: bool,
    /// Pinch out zooms a pane, pinch in unzooms it (`@tmuxy-gesture-pinch-zoom`).
    pub gesture_pinch_zoom: bool,
    /// Pinch in on an unzoomed tab opens the "all tabs" view
    /// (`@tmuxy-gesture-pinch-overview`).
    pub gesture_pinch_overview: bool,
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
            tab_overview_cols: 3,
            gesture_swipe_tabs: true,
            gesture_pinch_zoom: true,
            gesture_pinch_overview: true,
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
const SETTINGS_OPTIONS: [&str; 14] = [
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
    tmux_options::TAB_OVERVIEW_COLS,
    tmux_options::GESTURE_SWIPE_TABS,
    tmux_options::GESTURE_PINCH_ZOOM,
    tmux_options::GESTURE_PINCH_OVERVIEW,
];

/// One command list printing every settings option, a line each. An unset
/// option prints an empty line, which the parsers below read as "use the
/// default".
fn settings_query() -> String {
    SETTINGS_OPTIONS
        .iter()
        .map(|option| format!("display-message -p '#{{{option}}}'"))
        .collect::<Vec<_>>()
        .join(" ; ")
}

/// The settings from what [`settings_query`] printed, with the defaults for
/// anything unset or malformed. Returns `{ "theme", "mode", "appearance" }`.
fn parse_settings(output: &str) -> serde_json::Value {
    let mut fields = output.lines().map(str::trim);
    let mut next = || fields.next().unwrap_or("");
    let theme = next();
    let mode = next();
    let defaults = Appearance::default();
    let appearance = Appearance {
        opacity: parse_opacity(next(), defaults.opacity),
        active_pane_opacity: parse_opacity(next(), defaults.active_pane_opacity),
        inactive_pane_opacity: parse_opacity(next(), defaults.inactive_pane_opacity),
        active_text_opacity: parse_opacity(next(), defaults.active_text_opacity),
        inactive_text_opacity: parse_opacity(next(), defaults.inactive_text_opacity),
        blur: parse_flag(next(), defaults.blur),
        animations: parse_flag(next(), defaults.animations),
        cursor_blink: parse_flag(next(), defaults.cursor_blink),
        tab_overview_cols: parse_count(next(), defaults.tab_overview_cols, MAX_TAB_OVERVIEW_COLS),
        gesture_swipe_tabs: parse_flag(next(), defaults.gesture_swipe_tabs),
        gesture_pinch_zoom: parse_flag(next(), defaults.gesture_pinch_zoom),
        gesture_pinch_overview: parse_flag(next(), defaults.gesture_pinch_overview),
    };
    serde_json::json!({
        "theme": if theme.is_empty() { DEFAULT_THEME } else { theme },
        "mode": if mode.is_empty() { DEFAULT_MODE } else { mode },
        "appearance": appearance,
    })
}

/// Read the active theme name + mode and the appearance from tmux in one
/// round trip, applying the defaults. Returns `{ "theme", "mode",
/// "appearance" }` — the wire shape the `get_theme_settings` Tauri command,
/// the `GetThemeSettings` SSE command and the `theme-settings` push (after the
/// config is sourced) all share.
pub async fn get_theme_settings(tx: &MonitorCommandSender) -> Result<serde_json::Value, String> {
    let output = query(tx, &settings_query()).await?;
    Ok(parse_settings(&output))
}

/// A value written into a control-mode command line. Quoting keeps `;` and
/// spaces literal; a control character would end the line and start another
/// command, so it is refused.
fn option_value(value: &str) -> Result<String, String> {
    if value.chars().any(char::is_control) {
        return Err(format!("not a usable option value: {value:?}"));
    }
    Ok(tmux_quote(value))
}

/// Set global options in one command list.
async fn set_options(
    tx: &MonitorCommandSender,
    options: &[(&str, &str)],
    what: &str,
) -> Result<(), String> {
    let mut commands = Vec::with_capacity(options.len());
    for (option, value) in options {
        commands.push(format!("set-option -g {option} {}", option_value(value)?));
    }
    query(tx, &commands.join(" ; "))
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to set {what}: {e}"))
}

/// Turn the cursor's blink on or off, and remember the choice.
///
/// The live tmux option is what the clients read; the state file is what
/// makes it survive a tmux server restart. A `@tmuxy-cursor-blink` line in
/// the user's own `tmuxy.conf` is the default this starts from — set it
/// there and the app never has to be told.
pub async fn set_cursor_blink(tx: &MonitorCommandSender, enabled: bool) -> Result<(), String> {
    let value = if enabled { "on" } else { "off" };
    set_options(tx, &[(tmux_options::CURSOR_BLINK, value)], "cursor blink").await?;
    if let Err(e) = session::write_managed_state(None, None, Some(enabled), None) {
        tracing::warn!(error = %e, "could not persist the cursor blink to tmuxy.state.json");
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
) -> Result<(), String> {
    let mut options = vec![(tmux_options::THEME, name)];
    if let Some(m) = mode {
        options.push((tmux_options::THEME_MODE, m));
    }
    set_options(tx, &options, "theme").await?;
    if let Err(e) = session::write_managed_state(Some(name), mode, None, None) {
        tracing::warn!(error = %e, "could not persist theme to tmuxy.state.json");
    }
    Ok(())
}

/// Set only the mode (dark/light) and persist it.
pub async fn set_theme_mode(tx: &MonitorCommandSender, mode: &str) -> Result<(), String> {
    set_options(tx, &[(tmux_options::THEME_MODE, mode)], "theme mode").await?;
    if let Err(e) = session::write_managed_state(None, Some(mode), None, None) {
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

/// Available themes as the `[{ name, displayName }]` wire shape both
/// transports serve. Backed by `session::list_themes()` (the same scan the
/// native menu uses).
pub fn get_themes_list() -> serde_json::Value {
    let themes: Vec<serde_json::Value> = session::list_themes()
        .into_iter()
        .map(|name| {
            let display_name = display_theme_name(&name);
            serde_json::json!({ "name": name, "displayName": display_name })
        })
        .collect();
    serde_json::json!(themes)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn display_theme_name_title_cases_hyphenated_stems() {
        assert_eq!(display_theme_name("tokyo-night"), "Tokyo Night");
        assert_eq!(display_theme_name("default"), "Default");
        assert_eq!(display_theme_name(""), "");
    }

    /// One round trip reads every option; an unset one is the default.
    #[test]
    fn settings_are_read_in_one_query_and_unset_options_take_the_defaults() {
        let query = settings_query();
        for option in SETTINGS_OPTIONS {
            assert!(
                query.contains(&format!("display-message -p '#{{{option}}}'")),
                "{option}"
            );
        }

        let mut printed = vec![""; SETTINGS_OPTIONS.len()];
        printed[0] = "nord";
        printed[2] = "0.5";
        printed[7] = "off";
        printed[10] = "40";
        let settings = parse_settings(&format!("{}\n", printed.join("\n")));
        assert_eq!(settings["theme"], "nord");
        assert_eq!(settings["mode"], DEFAULT_MODE);
        assert_eq!(settings["appearance"]["opacity"], 0.5);
        assert_eq!(settings["appearance"]["blur"], false);
        assert_eq!(
            settings["appearance"]["tabOverviewCols"],
            MAX_TAB_OVERVIEW_COLS
        );
        assert_eq!(settings["appearance"]["animations"], true);

        let empty = parse_settings("");
        assert_eq!(empty["theme"], DEFAULT_THEME);
        assert_eq!(
            empty["appearance"],
            serde_json::to_value(Appearance::default()).unwrap()
        );
    }

    /// The value goes into a control-mode command line: quoted so `;` stays
    /// literal, and refused if it carries a line break.
    #[test]
    fn an_option_value_cannot_end_the_command_line() {
        assert_eq!(option_value("nord").unwrap(), "'nord'");
        assert_eq!(
            option_value("a ; kill-server").unwrap(),
            "'a ; kill-server'"
        );
        assert!(option_value("a\nkill-server").is_err());
    }

    #[test]
    fn parse_count_accepts_whole_numbers_and_caps_them() {
        assert_eq!(parse_count("5", 3, 12), 5);
        assert_eq!(parse_count(" 2\n", 3, 12), 2);
        assert_eq!(parse_count("40", 3, 12), 12);
        assert_eq!(parse_count("0", 3, 12), 3);
        assert_eq!(parse_count("-1", 3, 12), 3);
        assert_eq!(parse_count("2.5", 3, 12), 3);
        assert_eq!(parse_count("", 3, 12), 3);
    }
}
