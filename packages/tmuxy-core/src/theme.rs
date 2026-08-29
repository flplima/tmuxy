//! Theme operations shared by both transports.
//!
//! The SSE server and the Tauri app used to carry near-verbatim copies of
//! these handlers — which had already drifted (one used the
//! `tmux_options::THEME` constants, the other hardcoded `"@tmuxy-theme"`
//! strings). One implementation over `&Ctx` keeps them in lockstep.

use crate::constants::tmux_options;
use crate::ctx::Ctx;
use crate::session;

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
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            opacity: 0.7,
            active_pane_opacity: 1.0,
            inactive_pane_opacity: 0.7,
            active_text_opacity: 1.0,
            inactive_text_opacity: 0.7,
            blur: true,
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

async fn read_option(ctx: &Ctx, option: &'static str, op: &'static str) -> String {
    ctx.tmux_call(
        vec!["show-options".into(), "-gqv".into(), option.into()],
        op,
    )
    .await
    .map(|s| s.trim().to_string())
    .unwrap_or_default()
}

/// Read the appearance options from tmux, applying [`Appearance::default`]
/// for any that are unset or malformed.
pub async fn get_appearance(ctx: &Ctx) -> Appearance {
    let defaults = Appearance::default();
    let opacity = |option, op, default| async move {
        parse_opacity(&read_option(ctx, option, op).await, default)
    };
    Appearance {
        opacity: opacity(
            tmux_options::OPACITY,
            "appearance:opacity",
            defaults.opacity,
        )
        .await,
        active_pane_opacity: opacity(
            tmux_options::ACTIVE_PANE_OPACITY,
            "appearance:active-pane",
            defaults.active_pane_opacity,
        )
        .await,
        inactive_pane_opacity: opacity(
            tmux_options::INACTIVE_PANE_OPACITY,
            "appearance:inactive-pane",
            defaults.inactive_pane_opacity,
        )
        .await,
        active_text_opacity: opacity(
            tmux_options::ACTIVE_TEXT_OPACITY,
            "appearance:active-text",
            defaults.active_text_opacity,
        )
        .await,
        inactive_text_opacity: opacity(
            tmux_options::INACTIVE_TEXT_OPACITY,
            "appearance:inactive-text",
            defaults.inactive_text_opacity,
        )
        .await,
        blur: parse_flag(
            &read_option(ctx, tmux_options::BLUR, "appearance:blur").await,
            defaults.blur,
        ),
    }
}

/// Read the active theme name + mode and the appearance from tmux, applying
/// the defaults. Returns `{ "theme", "mode", "appearance" }` — the wire shape
/// the `get_theme_settings` Tauri command, the `GetThemeSettings` SSE command
/// and the `theme-settings` push (after the config is sourced) all share.
pub async fn get_theme_settings(ctx: &Ctx) -> serde_json::Value {
    let theme = read_option(ctx, tmux_options::THEME, "theme:get").await;
    let mode = read_option(ctx, tmux_options::THEME_MODE, "theme-mode:get").await;
    let appearance = get_appearance(ctx).await;
    serde_json::json!({
        "theme": if theme.is_empty() { DEFAULT_THEME.to_string() } else { theme },
        "mode": if mode.is_empty() { DEFAULT_MODE.to_string() } else { mode },
        "appearance": appearance,
    })
}

/// Set the theme (and optionally the mode) in tmux and persist the choice so
/// it survives a tmux server restart. Persistence failure is non-fatal — the
/// live option is already set — and is logged, not returned.
pub async fn set_theme(ctx: &Ctx, name: &str, mode: Option<&str>) -> Result<(), String> {
    ctx.tmux_call(
        vec![
            "set-option".into(),
            "-g".into(),
            tmux_options::THEME.into(),
            name.to_string(),
        ],
        "theme:set",
    )
    .await
    .map_err(|e| format!("Failed to set theme: {}", e))?;
    if let Some(m) = mode {
        ctx.tmux_call(
            vec![
                "set-option".into(),
                "-g".into(),
                tmux_options::THEME_MODE.into(),
                m.to_string(),
            ],
            "theme-mode:set",
        )
        .await
        .map_err(|e| format!("Failed to set theme mode: {}", e))?;
    }
    if let Err(e) = session::write_managed_state(Some(name), mode) {
        tracing::warn!(error = %e, "could not persist theme to tmuxy.state.json");
    }
    Ok(())
}

/// Set only the mode (dark/light) and persist it.
pub async fn set_theme_mode(ctx: &Ctx, mode: &str) -> Result<(), String> {
    ctx.tmux_call(
        vec![
            "set-option".into(),
            "-g".into(),
            tmux_options::THEME_MODE.into(),
            mode.to_string(),
        ],
        "theme-mode:set",
    )
    .await
    .map_err(|e| format!("Failed to set theme mode: {}", e))?;
    if let Err(e) = session::write_managed_state(None, Some(mode)) {
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
}
