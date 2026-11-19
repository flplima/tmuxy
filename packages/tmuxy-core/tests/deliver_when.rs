//! The send guard's checks against a real tmux. `ask::deliver_when`: the
//! sender's own condition is checked by tmux in the same step as the pane's
//! state. Keys go in while it holds; when it does not, nothing is typed, the send is refused as held and
//! no mark is left; a pane at a prompt is refused as at a prompt whatever the
//! condition says. `SendRules::mark_unread`: decided by tmux as it marks,
//! so it never covers an agent that started working meanwhile. Keys that
//! close their pane are sent, and leave nothing to mark.
//!
//! Needs a `tmux` binary; the socket is unique per process and no
//! control-mode client is attached.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use tmuxy_core::ask::{self, Argv, Refused};
use tmuxy_core::{CommandError, PaneId};

#[path = "common/scratch.rs"]
mod scratch;

struct Real<'a>(&'a scratch::ScratchServer);

impl ask::Tmux for Real<'_> {
    async fn read(&self, argv: Argv) -> Result<String, CommandError> {
        let out = tmuxy_core::session::local_tmux_on(&self.0.socket)
            .args(&argv)
            .output()
            .map_err(|e| CommandError::tmux(e.to_string()))?;
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    async fn mutate(&self, commands: Vec<Argv>) -> Result<(), CommandError> {
        let argv = commands.join(&";".to_string());
        let out = tmuxy_core::session::local_tmux_on(&self.0.socket)
            .args(&argv)
            .output()
            .map_err(|e| CommandError::tmux(e.to_string()))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(CommandError::tmux(
                String::from_utf8_lossy(&out.stderr).to_string(),
            ))
        }
    }
}

#[tokio::test]
async fn the_senders_condition_is_checked_as_the_keys_go_in() {
    let s = scratch::ScratchServer::with_session(
        &format!("deliver-when-{}", std::process::id()),
        100,
        30,
    );
    let log = s.home.join("typed.log");
    std::fs::write(&log, "").unwrap();
    let pane = s.tmux(&[
        "split-window",
        "-d",
        "-t",
        "work:0",
        "-P",
        "-F",
        "#{pane_id}",
        &format!("exec cat >> '{}'", log.display()),
    ]);
    let id = PaneId::parse(&pane).unwrap();
    let tmux = Real(&s);
    let typed = || {
        std::thread::sleep(Duration::from_millis(400));
        std::fs::read_to_string(&log).unwrap()
    };
    let keys = |text: &str| ask::send_keys_argv(&id, &[text.to_string(), "Enter".to_string()]);

    // Another program in front: held, nothing typed.
    let other = "#{==:#{pane_current_command},claude}";
    let refused = ask::deliver_when(&tmux, &id, keys("no"), Some(other)).await;
    assert!(matches!(refused, Err(Refused::Held(_))), "{refused:?}");
    assert_eq!(typed(), "");

    // The program the sender expects: typed.
    let same = "#{==:#{pane_current_command},cat}";
    ask::deliver_when(&tmux, &id, keys("yes"), Some(same))
        .await
        .unwrap();
    assert_eq!(typed(), "yes\n");

    // At a prompt, a condition that holds does not let the keys in.
    s.tmux(&[
        "set-option",
        "-p",
        "-t",
        &pane,
        "@tmuxy-pane-state",
        "needs-input",
    ]);
    let refused = ask::deliver_when(&tmux, &id, keys("1"), Some(same)).await;
    assert!(matches!(refused, Err(Refused::AtPrompt(_))), "{refused:?}");
    assert_eq!(typed(), "yes\n");

    let options = s.tmux(&["show-options", "-p", "-t", &pane]);
    assert!(!options.contains("@tmuxy-send-held"), "{options}");
}

/// A send that skipped the question marks the pane unread only if it is
/// still quiet as tmux marks it: an agent that already took the keys up and
/// says it is working stays working.
#[tokio::test]
async fn unread_never_covers_an_agent_that_started_working() {
    let s = scratch::ScratchServer::with_session(
        &format!("mark-unread-{}", std::process::id()),
        100,
        30,
    );
    let pane = s.tmux(&["display-message", "-p", "-t", "work:0.0", "#{pane_id}"]);
    let id = PaneId::parse(&pane).unwrap();
    let tmux = Real(&s);
    let state = || s.tmux(&["show-options", "-pqv", "-t", &pane, "@tmuxy-pane-state"]);

    // Read while the pane was quiet; the agent starts working before the mark.
    let rules = ask::SendRules::read(&tmux, &id).await.unwrap();
    s.tmux(&[
        "set-option",
        "-p",
        "-t",
        &pane,
        "@tmuxy-pane-state",
        "working",
    ]);
    rules.mark_unread(&tmux, &id).await.unwrap();
    assert_eq!(state(), "working");

    // Still quiet as the mark goes on: unread.
    s.tmux(&["set-option", "-pu", "-t", &pane, "@tmuxy-pane-state"]);
    let rules = ask::SendRules::read(&tmux, &id).await.unwrap();
    rules.mark_unread(&tmux, &id).await.unwrap();
    assert_eq!(state(), "unread");
}

/// Real tmux, but a mutation returns only once `pane` has closed: where a
/// send whose keys closed their pane stands when it reads its mark back.
struct ClosesAfterTyping<'a> {
    real: Real<'a>,
    pane: &'a str,
}

impl ask::Tmux for ClosesAfterTyping<'_> {
    async fn read(&self, argv: Argv) -> Result<String, CommandError> {
        self.real.read(argv).await
    }

    async fn mutate(&self, commands: Vec<Argv>) -> Result<(), CommandError> {
        self.real.mutate(commands).await?;
        let open = || {
            self.real
                .0
                .tmux(&["list-panes", "-a", "-F", "#{pane_id}"])
                .lines()
                .any(|id| id == self.pane)
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while open() {
            assert!(
                std::time::Instant::now() < deadline,
                "{} stayed open",
                self.pane
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(())
    }
}

/// Keys that close the pane they go into (`exit`, `q` to a pager) are sent:
/// the pane, and the mark that would have said they were held, are gone by
/// the time the send looks, and neither that nor marking the pane unread
/// afterwards is a failure. A caller told otherwise retries, and a retried
/// `exit` closes whichever pane it lands in next.
#[tokio::test]
async fn keys_that_close_their_pane_are_sent() {
    let s = scratch::ScratchServer::with_session(
        &format!("deliver-closes-{}", std::process::id()),
        100,
        30,
    );
    let log = s.home.join("typed.log");
    std::fs::write(&log, "").unwrap();
    let pane = s.tmux(&[
        "split-window",
        "-d",
        "-t",
        "work:0",
        "-P",
        "-F",
        "#{pane_id}",
        &format!("exec head -n 1 >> '{}'", log.display()),
    ]);
    let id = PaneId::parse(&pane).unwrap();
    let tmux = ClosesAfterTyping {
        real: Real(&s),
        pane: &pane,
    };

    let rules = ask::SendRules::read(&tmux, &id).await.unwrap();
    let keys = ask::send_keys_argv(&id, &["bye".to_string(), "Enter".to_string()]);
    ask::deliver(&tmux, &id, keys).await.unwrap();
    assert_eq!(std::fs::read_to_string(&log).unwrap(), "bye\n");
    rules.mark_unread(&tmux, &id).await.unwrap();
}
