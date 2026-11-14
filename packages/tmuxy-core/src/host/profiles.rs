//! The View menu's profile commands (`crate::profiles`), for the caller's
//! session. Each answers the profiles there are and the one the session uses.
//!
//! A switch reaches tmux first and is written down only once tmux took it,
//! then every client of the session is sent the new theme settings, which
//! read the session's own values: the page repaints with no reload.

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
