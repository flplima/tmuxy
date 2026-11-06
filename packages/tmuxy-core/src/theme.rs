//! Theme operations shared by both transports.
//!
//! The SSE server and the Tauri app used to carry near-verbatim copies of
//! these handlers — which had already drifted (one used the
//! `tmux_options::THEME` constants, the other hardcoded `"@tmuxy-theme"`
//! strings). One implementation over the monitor's command channel keeps them
//! in lockstep, and keeps every read and write on the control-mode connection
//! (an external `tmux` while it is attached can crash tmux 3.5a).

use crate::client_size::SizePolicy;
use crate::constants::tmux_options;
use crate::control_mode::MonitorCommandSender;
use crate::executor::tmux_quote;
use crate::session::{self, ManagedOption};
use crate::transport::query;
use crate::CommandError;

mod css_vars;
mod icons;
use css_vars::parse_css_vars;

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
    /// Whether the window is see-through at all (`@tmuxy-transparency`):
    /// off, the surfaces paint opaque and there is no blur, whatever the
    /// opacities and `blur` say.
    pub transparency: bool,
    /// Layout animations on or off (`@tmuxy-animations`).
    pub animations: bool,
    /// Whether the cursor blinks when the application has not asked for a
    /// particular cursor (`@tmuxy-cursor-blink`).
    pub cursor_blink: bool,
    /// Whether a send into another pane asks first (`@tmuxy-send-ask`).
    pub send_ask: bool,
    /// Push a notification when a pane needs the user (`@tmuxy-notify`).
    pub notify: bool,
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
    /// How the session is sized across clients (`@tmuxy-size`): the backend
    /// sizes the window by it, the client scales its grid to fit.
    pub size: SizePolicy,
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
            transparency: true,
            animations: true,
            cursor_blink: true,
            send_ask: true,
            notify: true,
            tab_overview_cols: 3,
            gesture_swipe_tabs: true,
            gesture_pinch_zoom: true,
            gesture_pinch_overview: true,
            native_menus: true,
            size: SizePolicy::Smallest,
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
const SETTINGS_OPTIONS: [&str; 19] = [
    tmux_options::THEME,
    tmux_options::THEME_MODE,
    tmux_options::OPACITY,
    tmux_options::ACTIVE_PANE_OPACITY,
    tmux_options::INACTIVE_PANE_OPACITY,
    tmux_options::ACTIVE_TEXT_OPACITY,
    tmux_options::INACTIVE_TEXT_OPACITY,
    tmux_options::BLUR,
    tmux_options::TRANSPARENCY,
    tmux_options::ANIMATIONS,
    tmux_options::CURSOR_BLINK,
    tmux_options::SEND_ASK,
    tmux_options::NOTIFY,
    tmux_options::TAB_OVERVIEW_COLS,
    tmux_options::GESTURE_SWIPE_TABS,
    tmux_options::GESTURE_PINCH_ZOOM,
    tmux_options::GESTURE_PINCH_OVERVIEW,
    tmux_options::NATIVE_MENUS,
    tmux_options::SIZE,
];

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

/// The theme name and mode, the appearance, the `@tmuxy-css-*` variables and
/// `@tmuxy-icon-*` icons, and the options the user's `tmuxy.conf` pins — the
/// answer to `get_theme_settings` and the `theme-settings` event alike.
/// `pinned` lists `@tmuxy-*` option names; the menu shows those as set in
/// tmuxy.conf rather than offering to change them.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSettings {
    /// A stylesheet the client loads by path.
    pub theme: String,
    /// `dark`, `light` or `auto`.
    pub mode: String,
    pub appearance: Appearance,
    /// `{ "<name>": "<value>" }`, the `--` dropped: one CSS declaration each.
    pub css_vars: serde_json::Map<String, serde_json::Value>,
    /// `{ "<process>": "<text or data: URL>" }`.
    pub icons: serde_json::Map<String, serde_json::Value>,
    pub pinned: Vec<&'static str>,
}

/// The settings from what [`settings_query`] printed, with the defaults for
/// anything unset or malformed; the icons not yet read from disk and nothing
/// pinned.
fn parse_settings(output: &str) -> ThemeSettings {
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
        transparency: parse_flag(value(tmux_options::TRANSPARENCY), defaults.transparency),
        animations: parse_flag(value(tmux_options::ANIMATIONS), defaults.animations),
        cursor_blink: parse_flag(value(tmux_options::CURSOR_BLINK), defaults.cursor_blink),
        send_ask: parse_flag(value(tmux_options::SEND_ASK), defaults.send_ask),
        notify: parse_flag(value(tmux_options::NOTIFY), defaults.notify),
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
        size: SizePolicy::parse(value(tmux_options::SIZE)),
    };
    let icons = icons::parse(lines.iter().copied());
    // A theme that is gone (its plugin removed, its file deleted) falls back
    // to the default rather than leaving the page unstyled.
    let theme = if session::is_safe_css_name(theme)
        && crate::plugins::themes::resolve_css(&format!("themes/{theme}.css")).is_some()
    {
        theme
    } else {
        DEFAULT_THEME
    };
    ThemeSettings {
        theme: theme.to_string(),
        mode: if matches!(mode, "dark" | "light" | "auto") {
            mode
        } else {
            DEFAULT_MODE
        }
        .to_string(),
        appearance,
        css_vars: parse_css_vars(lines.iter().copied()),
        icons,
        pinned: Vec::new(),
    }
}

/// Read the theme settings from tmux in one round trip, the SVG icons from
/// the config dir, and the options the user's `tmuxy.conf` pins.
pub async fn get_theme_settings(tx: &MonitorCommandSender) -> Result<ThemeSettings, CommandError> {
    let output = query(tx, &settings_query()).await?;
    let mut settings = parse_settings(&output);
    icons::inline_svgs(
        &mut settings.icons,
        &crate::paths::Layout::current().path(&crate::paths::USER_ICONS),
    );
    settings.pinned = session::pinned_options();
    Ok(settings)
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

/// The options a menu may change: those of `options` the user's `tmuxy.conf`
/// does not pin. Config beats menu state, so a pinned option keeps the value
/// the file gives it; a change made of nothing but pinned options is refused,
/// naming them, rather than silently dropped.
fn unpinned<'a>(
    options: &[(&'a str, &'a str)],
    pinned: &[&str],
) -> Result<Vec<(&'a str, &'a str)>, CommandError> {
    let free: Vec<_> = options
        .iter()
        .copied()
        .filter(|(option, _)| !pinned.contains(option))
        .collect();
    if free.is_empty() {
        let names: Vec<&str> = options.iter().map(|(option, _)| *option).collect();
        return Err(CommandError::invalid(format!(
            "{} is set in tmuxy.conf",
            names.join(", ")
        )));
    }
    Ok(free)
}

/// Set the [`unpinned`] options among `options` in tmux, and remember the
/// choice in `tmuxy.state.json` so it survives a tmux server restart. The
/// live option is what the clients read; a failure to remember it is logged,
/// not returned, since the option is already set.
async fn set_managed(
    tx: &MonitorCommandSender,
    options: &[(ManagedOption, &str)],
    what: &str,
) -> Result<(), CommandError> {
    let named: Vec<(&str, &str)> = options.iter().map(|(o, v)| (o.name(), *v)).collect();
    let free = unpinned(&named, &session::pinned_options())?;
    set_options(tx, &free, what).await?;
    for (option, value) in options {
        if !free.iter().any(|(name, _)| *name == option.name()) {
            continue;
        }
        if let Err(e) = session::write_managed_state(option.remembering(value)) {
            tracing::warn!(error = %e, "could not persist the {what} to tmuxy.state.json");
        }
    }
    Ok(())
}

/// Turn one of the menus' switches on or off, and remember the choice. A line
/// setting it in the user's own `tmuxy.conf` pins it: the menu cannot change
/// it then.
pub async fn set_flag(
    tx: &MonitorCommandSender,
    option: ManagedOption,
    enabled: bool,
) -> Result<(), CommandError> {
    let value = if enabled { "on" } else { "off" };
    set_managed(tx, &[(option, value)], option.name()).await
}

/// Set the theme (and optionally the mode) in tmux and remember the choice.
/// Whichever of the two the user's `tmuxy.conf` pins is left as the file has
/// it.
pub async fn set_theme(
    tx: &MonitorCommandSender,
    name: &str,
    mode: Option<&str>,
) -> Result<(), CommandError> {
    let mut options = vec![(ManagedOption::Theme, name)];
    if let Some(m) = mode {
        options.push((ManagedOption::ThemeMode, m));
    }
    set_managed(tx, &options, "theme").await
}

/// Set only the mode (dark/light) and remember it.
pub async fn set_theme_mode(tx: &MonitorCommandSender, mode: &str) -> Result<(), CommandError> {
    set_managed(tx, &[(ManagedOption::ThemeMode, mode)], "theme mode").await
}

/// Human-readable display name for a theme file stem:
/// `tokyo-night` → `Tokyo Night`, and a plugin's `devtools__dark` →
/// `Dark (devtools)`.
pub fn display_theme_name(stem: &str) -> String {
    if let Some((plugin, id)) = stem.split_once("__") {
        return format!("{} ({plugin})", display_theme_name(id));
    }
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

/// Available themes. Backed by `session::list_themes()` (the same scan the
/// native menu uses); `modes` is what each file's CSS declares a palette
/// for, so the menu can grey out a mode the theme has not got.
pub fn get_themes_list() -> Vec<ThemeInfo> {
    let mut names = session::list_themes();
    for (name, _) in crate::plugins::themes::list(&crate::paths::Layout::current()) {
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
        .into_iter()
        .map(|name| ThemeInfo {
            display_name: display_theme_name(&name),
            modes: crate::plugins::themes::resolve_css(&format!("themes/{name}.css"))
                .map(|css| session::theme_modes(&String::from_utf8_lossy(&css)))
                .unwrap_or_default(),
            name,
        })
        .collect()
}

/// One theme the View menu offers: its stylesheet's name, the name it is
/// shown by, and the modes the stylesheet defines.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeInfo {
    pub name: String,
    pub display_name: String,
    pub modes: Vec<&'static str>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
