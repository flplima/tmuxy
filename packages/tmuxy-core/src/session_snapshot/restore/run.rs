//! Running a restore plan: the `#<key>#` answers threaded through the steps
//! after the one that asked, and the one `run` that touches tmux.

use std::collections::BTreeMap;
use std::future::Future;

use super::*;

/// Fill `#<key>#` placeholders from the answers so far.
pub fn fill(argv: &[String], answers: &BTreeMap<String, String>) -> TmuxArgv {
    argv.iter()
        .map(|a| {
            let mut out = a.clone();
            for (key, value) in answers {
                out = out.replace(&format!("#{key}#"), value);
            }
            out
        })
        .collect()
}

/// Run every step of `steps` through `run`, threading answers into the steps
/// after them.
///
/// `run` is the only thing that touches tmux — a monitor's reply channel
/// (`via_monitor`), a subprocess from the CLI, or a fake in a test — which is
/// what lets a plan be tested by reading it back and the executor be tested
/// without tmux. It takes one tmux command as argv (without `tmux`) and
/// returns what the command printed.
pub async fn run_steps<F, Fut>(steps: &[Step], mut run: F) -> Result<(), TmuxError>
where
    F: FnMut(Vec<String>) -> Fut,
    Fut: Future<Output = Result<String, TmuxError>>,
{
    let mut answers = BTreeMap::new();
    for step in steps {
        match step {
            Step::Run(argv) => {
                run(fill(argv, &answers)).await?;
            }
            Step::Ask { key, argv } => {
                let answer = run(fill(argv, &answers)).await?.trim().to_string();
                answers.insert(key.clone(), answer);
            }
        }
    }
    Ok(())
}

/// Plan and run a restore through `run` (see `run_steps`).
pub async fn apply<F, Fut>(
    snapshot: &Snapshot,
    options: &RestoreOptions,
    run: F,
) -> Result<(), TmuxError>
where
    F: FnMut(Vec<String>) -> Fut,
    Fut: Future<Output = Result<String, TmuxError>>,
{
    if crate::session::SessionName::parse(&snapshot.session).is_none() {
        return Err(TmuxError::other(format!(
            "not a usable session name: {:?}",
            snapshot.session
        )));
    }
    run_steps(&plan(snapshot, options), run).await
}
