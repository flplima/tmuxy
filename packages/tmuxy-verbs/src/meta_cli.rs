//! `tmuxy pane meta`: set, unset, list and clear a pane's custom fields
//! (`tmuxy_core::pane_meta`), which its row in the sidebar tree shows. The
//! script resolves the target; the fields' rules are core's.

use std::time::{SystemTime, UNIX_EPOCH};

use tmuxy_core::ask::{self, Argv};
use tmuxy_core::constants::tmux_options::PANE_META;
use tmuxy_core::pane_meta::{self, Field, Fields, MAX_FIELDS};
use tmuxy_core::PaneId;

use crate::cli_json::{self, Answer, EXIT_FAILED, EXIT_USAGE};

#[derive(clap::Args, Debug)]
pub struct MetaArgs {
    /// The pane whose fields these are (a pane id).
    #[arg(long)]
    target: String,
    /// Answer in JSON.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    action: MetaAction,
}

#[derive(clap::Subcommand, Debug)]
enum MetaAction {
    /// Set fields, each `key=value`; a key already set takes the new value.
    Set {
        /// Show them for this long (`30s`, `5m`, `2h`, `1d`), then not.
        #[arg(long)]
        ttl: Option<String>,
        #[arg(required = true)]
        pairs: Vec<String>,
    },
    /// Take fields off by key; a key not set is no error.
    Unset {
        #[arg(required = true)]
        keys: Vec<String>,
    },
    /// The fields shown now.
    List,
    /// Take every field off.
    Clear,
}

pub async fn run(args: MetaArgs) {
    let answer = Answer::new(args.json);
    let code = match meta(&crate::send_cli::CliTmux, args, &answer, now()).await {
        Ok(()) => 0,
        Err((code, message)) => answer.fail(code, &message),
    };
    std::process::exit(code);
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

async fn meta<T: ask::Tmux>(
    tmux: &T,
    args: MetaArgs,
    answer: &Answer,
    now: u64,
) -> Result<(), (i32, String)> {
    let pane = PaneId::parse(&args.target)
        .map_err(|_| (EXIT_USAGE, format!("not a pane id: {}", args.target)))?;
    let read: Argv = [
        "display-message",
        "-p",
        "-t",
        pane.as_str(),
        &format!("#{{{PANE_META}}}"),
    ]
    .map(String::from)
    .to_vec();
    let option = tmux.read(read).await.map_err(|e| (EXIT_FAILED, e.error))?;
    let mut fields = pane_meta::live(pane_meta::decode(&option), now);
    match args.action {
        MetaAction::List => {
            answer.done(&report(&pane, &fields, now), &listing(&fields, now));
            return Ok(());
        }
        MetaAction::Set { ttl, pairs } => {
            let until = match ttl {
                Some(ttl) => {
                    let seconds = pane_meta::parse_ttl(&ttl).map_err(usage)?;
                    Some(now.checked_add(seconds).ok_or_else(|| {
                        usage(format!("`{ttl}` is longer than a time to live can be"))
                    })?)
                }
                None => None,
            };
            for pair in &pairs {
                let (key, value) = pair
                    .split_once('=')
                    .ok_or_else(|| usage(format!("`{pair}` is not key=value")))?;
                pane_meta::check_key(key).map_err(usage)?;
                let value = pane_meta::clean_value(value).map_err(usage)?;
                fields.insert(key.to_string(), Field { value, until });
            }
            if fields.len() > MAX_FIELDS {
                return Err((
                    EXIT_FAILED,
                    format!("a pane holds at most {MAX_FIELDS} fields; unset one first"),
                ));
            }
        }
        MetaAction::Unset { keys } => {
            for key in &keys {
                pane_meta::check_key(key).map_err(usage)?;
                fields.remove(key);
            }
        }
        MetaAction::Clear => fields.clear(),
    }
    let encoded = pane_meta::encode(&fields);
    let write: Vec<&str> = if encoded.is_empty() {
        vec!["set-option", "-pu", "-t", pane.as_str(), PANE_META]
    } else {
        vec!["set-option", "-p", "-t", pane.as_str(), PANE_META, &encoded]
    };
    tmux.mutate(vec![write.into_iter().map(String::from).collect()])
        .await
        .map_err(|e| (EXIT_FAILED, e.error))?;
    answer.done(&report(&pane, &fields, now), &listing(&fields, now));
    Ok(())
}

fn usage(message: String) -> (i32, String) {
    (EXIT_USAGE, message)
}

/// The JSON answer: the pane, and each field with the seconds it has left.
fn report(pane: &PaneId, fields: &Fields, now: u64) -> Vec<(&'static str, String)> {
    let fields: serde_json::Map<String, serde_json::Value> = fields
        .iter()
        .map(|(key, field)| {
            let left = field.until.map(|until| until.saturating_sub(now));
            (
                key.clone(),
                serde_json::json!({ "value": field.value, "secondsLeft": left }),
            )
        })
        .collect();
    vec![
        ("paneId", cli_json::string(pane.as_str())),
        ("fields", serde_json::Value::Object(fields).to_string()),
    ]
}

/// One `key  value` line a field, and how long it has left if it has a time.
fn listing(fields: &Fields, now: u64) -> String {
    if fields.is_empty() {
        return "no fields".into();
    }
    let width = fields.keys().map(String::len).max().unwrap_or(0);
    fields
        .iter()
        .map(|(key, field)| match field.until {
            Some(until) => format!(
                "{key:<width$}  {}  (for {}s)",
                field.value,
                until.saturating_sub(now)
            ),
            None => format!("{key:<width$}  {}", field.value),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests;
