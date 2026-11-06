//! Shared fixture for the tests that drive a real tmux on a scratch socket.

#![allow(dead_code)]

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tmuxy_core::control_mode::{
    CommandReply, LogSink, MonitorCommand, MonitorConfig, StateEmitter, TmuxMonitor,
};
use tmuxy_core::{StateUpdate, TmuxState};

/// Run one tmux command against the socket the test picked (`TMUX_SOCKET`)
/// and return what it printed. This is test scaffolding — setting the scene
/// before the monitor attaches, and tearing the server down after it has
/// detached — never something the crate itself does while a control-mode
/// client is attached.
pub fn tmux(args: &[&str]) -> Result<String, tmuxy_core::TmuxError> {
    let argv: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    tmuxy_core::session::tmux_output(&argv)
}

/// Poll `check` until it holds, or fail once `within` has passed. The
/// duration is a ceiling, never a wait: a test that slept a fixed time
/// instead failed on a slow runner and spent the whole time on a fast one.
pub async fn wait_until<F, Fut>(what: &str, within: Duration, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = tokio::time::Instant::now() + within;
    while !check().await {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A tmux server of the test's own. The whole crate resolves its socket from
/// `TMUX_SOCKET`, so each test binary holds one test that uses this: there is
/// nothing to race. The server is killed on drop, a failed assert included,
/// so a red run leaves no tmux behind.
pub struct ScratchServer;

impl ScratchServer {
    /// Point the crate at `tmuxy-<name>-<pid>`, a socket no real session uses.
    pub fn new(name: &str) -> Self {
        std::env::set_var(
            "TMUX_SOCKET",
            format!("tmuxy-{name}-{}", std::process::id()),
        );
        Self
    }

    /// A control-mode monitor attached to `session`, which it creates when
    /// `create` is set.
    pub async fn attach(&self, session: &str, create: bool) -> Monitor {
        let config = MonitorConfig {
            session: session.to_string(),
            create_session: create,
            ..Default::default()
        };
        let (mut monitor, tx) = TmuxMonitor::connect(config, None)
            .await
            .expect("control-mode connection on the scratch socket");
        let recorder = Arc::new(Recorder::default());
        let runner = {
            let recorder = Arc::clone(&recorder);
            tokio::spawn(async move { monitor.run(&*recorder).await })
        };
        Monitor {
            tx,
            recorder,
            runner,
        }
    }
}

impl Drop for ScratchServer {
    fn drop(&mut self) {
        let _ = tmux(&["kill-server"]);
    }
}

/// Every state and error the monitor emitted.
#[derive(Default)]
pub struct Recorder {
    pub updates: Mutex<Vec<StateUpdate>>,
    pub errors: Mutex<Vec<String>>,
}

impl LogSink for Recorder {}

impl StateEmitter for Recorder {
    fn emit_state(&self, update: StateUpdate) {
        self.updates.lock().unwrap().push(update);
    }
    fn emit_error(&self, error: String) {
        self.errors.lock().unwrap().push(error);
    }
}

/// A running monitor on the scratch server. Declared after its
/// [`ScratchServer`], it is dropped first, which stops it before the server
/// goes.
pub struct Monitor {
    pub tx: tokio::sync::mpsc::Sender<MonitorCommand>,
    pub recorder: Arc<Recorder>,
    runner: tokio::task::JoinHandle<()>,
}

impl Monitor {
    /// Run `command` through the monitor's reply channel.
    pub async fn ask(&self, command: &str) -> CommandReply {
        let (reply, rx) = tokio::sync::oneshot::channel();
        self.tx
            .send(MonitorCommand::RunCommandWithReply {
                command: command.to_string(),
                reply,
            })
            .await
            .expect("monitor accepts commands");
        tokio::time::timeout(Duration::from_secs(10), rx)
            .await
            .expect("a reply arrives within the deadline")
            .expect("the monitor answers rather than dropping the request")
    }

    /// The monitor's picture of the session, as a fresh client's baseline
    /// gets it.
    pub async fn state(&self) -> TmuxState {
        let (reply, rx) = tokio::sync::oneshot::channel();
        self.tx
            .send(MonitorCommand::GetState { reply })
            .await
            .expect("monitor accepts commands");
        tokio::time::timeout(Duration::from_secs(10), rx)
            .await
            .unwrap_or_else(|_| panic!("the state arrives; errors: {:?}", self.errors()))
            .expect("the monitor answered")
    }

    pub async fn send(&self, command: MonitorCommand) {
        self.tx
            .send(command)
            .await
            .expect("monitor accepts commands");
    }

    pub fn errors(&self) -> Vec<String> {
        self.recorder.errors.lock().unwrap().clone()
    }
}

impl Drop for Monitor {
    fn drop(&mut self) {
        self.runner.abort();
    }
}
