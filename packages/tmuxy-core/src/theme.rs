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

/// Read the active theme name + mode from tmux, applying the defaults.
/// Returns `{ "theme": ..., "mode": ... }` — the wire shape both the
/// `get_theme_settings` Tauri command and the `GetThemeSettings` SSE
/// command respond with.
pub async fn get_theme_settings(ctx: &Ctx) -> serde_json::Value {
    let read = |option: &'static str, op: &'static str| async move {
        ctx.tmux_call(
            vec!["show-options".into(), "-gqv".into(), option.into()],
            op,
        )
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
    };
    let theme = read(tmux_options::THEME, "theme:get").await;
    let mode = read(tmux_options::THEME_MODE, "theme-mode:get").await;
    serde_json::json!({
        "theme": if theme.is_empty() { DEFAULT_THEME.to_string() } else { theme },
        "mode": if mode.is_empty() { DEFAULT_MODE.to_string() } else { mode },
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
