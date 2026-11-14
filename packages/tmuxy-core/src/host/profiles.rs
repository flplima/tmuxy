//! The View menu's profile commands (`crate::profiles`), for the caller's
//! session. Each answers the profiles there are and the one the session uses.
//!
//! A switch reaches tmux first and is written down only once tmux took it,
//! then every client of the session is sent the new theme settings, which
//! read the session's own values: the page repaints with no reload.
//!
//! In a session on a named profile, a menu change (theme, mode, blinking
//! cursor, transparency) is saved into the profile and set on that session
//! only ([`into_profile`]); on the Default Profile it is the global change it
//! always was.

use std::path::Path;

use serde_json::Value;

use super::requests::to_json;
use super::SessionRuntime;
use crate::control_mode::query;
use crate::paths::Layout;
use crate::profiles::{self, Profile, ProfileError, ProfilesInfo, DEFAULT_PROFILE};
use crate::session;
use crate::CommandError;

pub(super) enum ProfileCall {
    List,
    Use(String),
    Create { name: String, from: Option<String> },
    Rename { from: String, to: String },
    Delete(String),
}

pub(super) async fn run(
    runtime: &SessionRuntime,
    call: ProfileCall,
) -> Result<Value, CommandError> {
    let dir = profiles::profiles_dir(&Layout::current());
    let name = runtime.session();
    match call {
        ProfileCall::List => {}
        ProfileCall::Use(profile) => switch(runtime, &dir, &profile).await?,
        ProfileCall::Create { name: new, from } => {
            let from = from.as_deref().unwrap_or(DEFAULT_PROFILE);
            profiles::create(&dir, &new, from).map_err(refused)?;
            switch(runtime, &dir, &new).await?;
        }
        ProfileCall::Rename { from, to } => {
            profiles::rename(&dir, &from, &to).map_err(refused)?;
            remember(|map| {
                for used in map.values_mut().filter(|used| **used == from) {
                    used.clone_from(&to);
                }
            })?;
            if session::session_profile(&name) == to {
                switch(runtime, &dir, &to).await?;
            }
        }
        ProfileCall::Delete(gone) => {
            let used_here = session::session_profile(&name) == gone;
            profiles::delete(&dir, &gone).map_err(refused)?;
            remember(|map| map.retain(|_, used| *used != gone))?;
            if used_here {
                apply(runtime, DEFAULT_PROFILE, &Profile::default()).await?;
            }
        }
    }
    to_json(
        ProfilesInfo {
            active: session::session_profile(&name),
            names: profiles::list(&dir),
        },
        "profiles",
    )
}

/// Move the session to `profile`: a profile that cannot be read is refused
/// before anything changes.
async fn switch(runtime: &SessionRuntime, dir: &Path, profile: &str) -> Result<(), CommandError> {
    let values = profiles::load(dir, profile).map_err(refused)?;
    apply(runtime, profile, &values).await?;
    let session = runtime.session();
    remember(|map| {
        if profile == DEFAULT_PROFILE {
            map.remove(&session);
        } else {
            map.insert(session.clone(), profile.to_string());
        }
    })
}

async fn apply(
    runtime: &SessionRuntime,
    profile: &str,
    values: &Profile,
) -> Result<(), CommandError> {
    let tx = runtime.channel().await?;
    let commands = profiles::switch_commands(
        &runtime.session(),
        profile,
        values,
        &session::pinned_options(),
    );
    query(&tx, &commands.join(" ; "))
        .await
        .map_err(|e| e.context("Failed to apply the profile"))?;
    runtime.push_theme_settings().await;
    Ok(())
}

/// A menu change, as tmux option names and values, made in a session on a
/// named profile: saved into the profile, then the profile is applied to the
/// session again. False, with nothing done, when the session is on the
/// Default Profile, when every option is pinned by `tmuxy.conf` (the global
/// path refuses that, naming them), or when one is no profile's to hold.
pub(super) async fn into_profile(
    runtime: &SessionRuntime,
    changes: &[(&str, &str)],
) -> Result<bool, CommandError> {
    let active = session::session_profile(&runtime.session());
    if active == DEFAULT_PROFILE {
        return Ok(false);
    }
    let Some(values) = save_change(&active, changes)? else {
        return Ok(false);
    };
    apply(runtime, &active, &values).await?;
    Ok(true)
}

/// Held across a profile's load, change and save, so two tabs changing the
/// same profile at once each keep the other's change.
static SAVING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// `changes` written into the profile `active`, or None when they are not
/// all a profile's to hold (see [`into_profile`]).
fn save_change(active: &str, changes: &[(&str, &str)]) -> Result<Option<Profile>, CommandError> {
    let _saving = SAVING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = profiles::profiles_dir(&Layout::current());
    let mut values = profiles::load(&dir, active).map_err(refused)?;
    let pinned = session::pinned_options();
    let free: Vec<_> = changes
        .iter()
        .filter(|(option, _)| !pinned.contains(option))
        .collect();
    if free.is_empty()
        || !free
            .iter()
            .all(|(option, value)| profiles::set_field(&mut values, option, value))
    {
        return Ok(None);
    }
    profiles::save(&dir, active, &values).map_err(refused)?;
    Ok(Some(values))
}

fn remember(
    edit: impl FnOnce(&mut std::collections::BTreeMap<String, String>),
) -> Result<(), CommandError> {
    session::edit_session_profiles(edit).map_err(|e| {
        CommandError::unavailable(format!("could not save which profile is used: {e}"))
    })
}

fn refused(e: ProfileError) -> CommandError {
    CommandError::invalid(e.to_string())
}
