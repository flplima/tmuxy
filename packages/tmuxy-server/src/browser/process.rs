//! A running engine: the fds, the reader task, and request/reply over them.
//!
//! `engine` decides what to launch, `pipe` decides how to talk; this is the part
//! that actually holds a child process and a pair of file descriptors open.
//!
//! Two things are worth knowing before reading it.
//!
//! **The fds are numbered from the CHILD's point of view.** The child reads
//! requests on fd 3 and writes replies on fd 4, so the parent holds the opposite
//! ends and has to place its halves at exactly 3 and 4 in the child between
//! `fork` and `exec`. That placement is the only `unsafe` here, and it is why
//! this module is unix-only.
//!
//! **CDP has two levels, and the useful one is not the default.** A fresh
//! connection speaks to the BROWSER: `Browser.*` and `Target.*` and nothing
//! else. `Page.navigate`, `Runtime.evaluate`, `Input.dispatchKeyEvent` — every
//! command this feature exists for — belong to a PAGE, and are refused with
//! `'Page.enable' wasn't found` until a page target has been attached to and
//! each message carries its `sessionId`. So `launch` attaches to a page and
//! `send` addresses it; `send_browser` is the escape hatch for the handful of
//! commands that really are browser-level.

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, Mutex};

use super::engine::{engine_command, EngineCommand};
use super::pipe::{frame, parse, Incoming, MessageReader, RequestIds, CDP_READ_FD, CDP_WRITE_FD};

/// How long a single CDP request may take before it is given up on.
///
/// Generous: a navigation to a slow site legitimately takes seconds, and this
/// is not a latency budget — it is the bound that keeps a wedged engine from
/// turning into a REPL that never prints a prompt again.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Anything that went wrong driving an engine.
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("could not start the browser: {0}")]
    Spawn(#[source] io::Error),
    #[error("the browser's pipe could not be set up: {0}")]
    Pipe(#[source] io::Error),
    #[error("the browser is gone")]
    Gone,
    #[error("{method} timed out after {}s", REQUEST_TIMEOUT.as_secs())]
    Timeout { method: String },
    #[error("{method} failed: {message}")]
    Protocol { method: String, message: String },
    #[error("the browser sent something unreadable: {0}")]
    Malformed(#[source] serde_json::Error),
}

/// A request waiting for its reply.
type Pending = oneshot::Sender<Result<serde_json::Value, String>>;

/// Everything needed to send a command and await its reply, with no access to
/// the child process.
///
/// Separate from `Engine`, and cloneable, because a background task has to be
/// able to talk to the engine while something else holds the session. The
/// screencast is the case that forced it: each frame must be acknowledged or
/// Chromium stops sending after its buffer fills, and the pump doing the
/// acknowledging cannot be holding the lock that the verbs also need.
pub struct Channel {
    /// The parent's write half of the child's fd 3.
    outbox: Mutex<tokio::fs::File>,
    /// Requests awaiting replies, by id.
    pending: Arc<Mutex<std::collections::HashMap<u64, Pending>>>,
    ids: Mutex<RequestIds>,
    /// The attached page's session id. Every page-level send carries it; see
    /// the module docs for why a connection without one can only talk to the
    /// browser.
    page_session: Mutex<String>,
}

/// A live engine process and the pipe to it.
pub struct Engine {
    child: Child,
    channel: Arc<Channel>,
    /// Events the browser reported on its own, taken once by whoever pumps
    /// them. `Session` does, so the screencast and console plumbing read from
    /// there rather than from here.
    events: Option<mpsc::UnboundedReceiver<(String, serde_json::Value)>>,
}

impl Engine {
    /// Launch `browser` with a profile at `profile`, read its pipe, and attach
    /// to a page so the page-level commands work.
    pub async fn launch(browser: &Path, profile: &Path) -> Result<Self, EngineError> {
        let engine = Self::launch_detached(browser, profile)?;
        let session = engine.attach_to_a_page().await?;
        *engine.channel.page_session.lock().await = session;
        Ok(engine)
    }

    /// The process and the pipe, with no page attached.
    ///
    /// Separate from `launch` because the attach has to send CDP commands,
    /// which needs the reader task already running — and because a caller that
    /// only wants `Browser.*` (a version probe, a graceful close) needs no page.
    pub fn launch_detached(browser: &Path, profile: &Path) -> Result<Self, EngineError> {
        std::fs::create_dir_all(profile).map_err(EngineError::Pipe)?;
        let EngineCommand { program, args } = engine_command(browser, profile);

        // Two pipes, named from the CHILD's point of view: it reads requests
        // from `to_child` and writes replies into `from_child`.
        let (to_child_read, to_child_write) = os_pipe()?;
        let (from_child_read, from_child_write) = os_pipe()?;

        let mut command = Command::new(&program);
        command
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            // Chromium writes its own diagnostics here, including the reason it
            // refused to start. Dropping them would make a failed launch
            // report only an exit code.
            .stderr(Stdio::piped());

        // Place the child's halves at fd 3 and 4. This runs in the forked child
        // before exec, where the only safe calls are async-signal-safe ones —
        // `dup2` is, and nothing else happens here.
        let child_read = to_child_read.as_raw_fd();
        let child_write = from_child_write.as_raw_fd();
        unsafe {
            use std::os::unix::process::CommandExt;
            command.pre_exec(move || {
                if libc::dup2(child_read, CDP_READ_FD) < 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::dup2(child_write, CDP_WRITE_FD) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let child = command.spawn().map_err(EngineError::Spawn)?;

        // The parent must close the ends it handed over. Holding the child's
        // write end open means this side never sees EOF when the engine exits,
        // so a dead engine reads as a quiet one and every request waits out its
        // timeout instead of failing immediately.
        drop(to_child_read);
        drop(from_child_write);

        let outbox = tokio::fs::File::from_std(std::fs::File::from(to_child_write));
        let inbox = tokio::fs::File::from_std(std::fs::File::from(from_child_read));

        let pending: Arc<Mutex<std::collections::HashMap<u64, Pending>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        let (event_tx, events) = mpsc::unbounded_channel();
        tokio::spawn(read_pipe(inbox, Arc::clone(&pending), event_tx));

        Ok(Self {
            child,
            channel: Arc::new(Channel {
                outbox: Mutex::new(outbox),
                pending,
                ids: Mutex::new(RequestIds::default()),
                page_session: Mutex::new(String::new()),
            }),
            events: Some(events),
        })
    }

    /// Find or make a page, attach to it, and return its session id.
    ///
    /// `flatten: true` is what makes the session usable on this one connection:
    /// without it the page's traffic is wrapped inside
    /// `Target.receivedMessageFromTarget` events and has to be unwrapped by
    /// hand, which is the old protocol and is deprecated.
    async fn attach_to_a_page(&self) -> Result<String, EngineError> {
        // The engine was started with `about:blank`, so a page usually exists
        // already. Reusing it rather than creating a second one keeps the
        // session to a single tab, which is what the pane shows.
        let targets = self
            .send_browser("Target.getTargets", serde_json::json!({}))
            .await?;
        let existing = targets
            .get("targetInfos")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .find(|info| info.get("type").and_then(serde_json::Value::as_str) == Some("page"))
            .and_then(|info| info.get("targetId").and_then(serde_json::Value::as_str))
            .map(str::to_string);

        let target_id = match existing {
            Some(id) => id,
            None => self
                .send_browser(
                    "Target.createTarget",
                    serde_json::json!({ "url": "about:blank" }),
                )
                .await?
                .get("targetId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| EngineError::Protocol {
                    method: "Target.createTarget".to_string(),
                    message: "no targetId in the reply".to_string(),
                })?
                .to_string(),
        };

        let attached = self
            .send_browser(
                "Target.attachToTarget",
                serde_json::json!({ "targetId": target_id, "flatten": true }),
            )
            .await?;

        attached
            .get("sessionId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| EngineError::Protocol {
                method: "Target.attachToTarget".to_string(),
                message: "no sessionId in the reply".to_string(),
            })
    }

    /// A handle to talk to this engine, cloneable and independent of the
    /// session lock.
    pub fn channel(&self) -> Arc<Channel> {
        Arc::clone(&self.channel)
    }

    /// Take the event stream. The second caller gets `None` — there is one
    /// stream, and two consumers would each see half the events.
    pub fn take_events(&mut self) -> Option<mpsc::UnboundedReceiver<(String, serde_json::Value)>> {
        self.events.take()
    }

    /// Send a page-level CDP command and wait for its reply.
    pub async fn send(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, EngineError> {
        self.channel.send(method, params).await
    }

    /// Send a browser-level CDP command: `Browser.*`, `Target.*`.
    pub async fn send_browser(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, EngineError> {
        self.channel.send_browser(method, params).await
    }

    /// Whatever the engine printed to stderr, for a launch that failed.
    pub fn take_stderr(&mut self) -> Option<std::process::ChildStderr> {
        self.child.stderr.take()
    }

    /// End the engine.
    ///
    /// `Browser.close` first, because it lets Chromium flush and release the
    /// profile lock; SIGKILL only if it does not go. A profile left locked by a
    /// half-dead engine is the one failure that outlives the session and breaks
    /// the NEXT one.
    pub async fn shutdown(&mut self) {
        let _ = self
            .send_browser("Browser.close", serde_json::json!({}))
            .await;
        for _ in 0..20 {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => tokio::time::sleep(Duration::from_millis(100)).await,
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Channel {
    /// Send a page-level CDP command and wait for its reply.
    ///
    /// This is what nearly everything wants: `Page.*`, `Runtime.*`, `Input.*`
    /// and `Emulation.*` are all addressed to the attached page.
    pub async fn send(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, EngineError> {
        let session = self.page_session.lock().await.clone();
        if session.is_empty() {
            // Reached only by a caller that used `launch_detached` and then
            // asked for a page command. Saying so beats the browser's
            // `'Page.enable' wasn't found`, which reads like a version problem.
            return Err(EngineError::Protocol {
                method: method.to_string(),
                message: "no page is attached; use Engine::launch, not launch_detached".to_string(),
            });
        }
        self.dispatch(method, params, Some(&session)).await
    }

    /// Send a browser-level CDP command: `Browser.*`, `Target.*`.
    pub async fn send_browser(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, EngineError> {
        self.dispatch(method, params, None).await
    }

    /// Fire a command and do not wait for the reply.
    ///
    /// For `Page.screencastFrameAck` and input events, where the reply carries
    /// nothing and waiting for it would serialise the pump against the frame
    /// rate — an ack that waits a round trip per frame is an ack that falls
    /// behind. The request id is still allocated and still correlated, so the
    /// reply is matched and discarded rather than mistaken for something else.
    pub async fn fire(&self, method: &str, params: serde_json::Value) -> Result<(), EngineError> {
        let session = self.page_session.lock().await.clone();
        let id = self.ids.lock().await.next_id();
        let mut payload = serde_json::json!({ "id": id, "method": method, "params": params });
        if !session.is_empty() {
            payload["sessionId"] = serde_json::Value::String(session);
        }
        let bytes = frame(&serde_json::to_vec(&payload).map_err(EngineError::Malformed)?);
        let mut outbox = self.outbox.lock().await;
        outbox
            .write_all(&bytes)
            .await
            .map_err(|_| EngineError::Gone)?;
        outbox.flush().await.map_err(|_| EngineError::Gone)?;
        Ok(())
    }

    async fn dispatch(
        &self,
        method: &str,
        params: serde_json::Value,
        session: Option<&str>,
    ) -> Result<serde_json::Value, EngineError> {
        let id = self.ids.lock().await.next_id();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let mut payload = serde_json::json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            // The field that decides whether this reaches the page or the
            // browser. Absent means browser.
            payload["sessionId"] = serde_json::Value::String(session.to_string());
        }
        let bytes = frame(&serde_json::to_vec(&payload).map_err(EngineError::Malformed)?);

        {
            let mut outbox = self.outbox.lock().await;
            // A broken pipe here means the engine exited; say so rather than
            // reporting an io error the caller cannot act on.
            outbox
                .write_all(&bytes)
                .await
                .map_err(|_| EngineError::Gone)?;
            outbox.flush().await.map_err(|_| EngineError::Gone)?;
        }

        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(message))) => Err(EngineError::Protocol {
                method: method.to_string(),
                message,
            }),
            // The reader task dropped the sender: the pipe hit EOF.
            Ok(Err(_)) => Err(EngineError::Gone),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(EngineError::Timeout {
                    method: method.to_string(),
                })
            }
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // Last resort. An engine leaked by a panic holds a profile lock and a
        // few hundred MB; nothing else would ever reap it.
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// Read the engine's pipe until EOF, routing replies and events.
async fn read_pipe(
    mut inbox: tokio::fs::File,
    pending: Arc<Mutex<std::collections::HashMap<u64, Pending>>>,
    events: mpsc::UnboundedSender<(String, serde_json::Value)>,
) {
    let mut reader = MessageReader::new();
    let mut buffer = vec![0u8; 64 * 1024];

    loop {
        let read = match inbox.read(&mut buffer).await {
            Ok(0) | Err(_) => break, // EOF, or the engine went away mid-read
            Ok(n) => n,
        };
        reader.feed(&buffer[..read]);

        while let Some(message) = reader.pop() {
            match parse(&message) {
                Ok(Incoming::Reply { id, outcome }) => {
                    if let Some(tx) = pending.lock().await.remove(&id) {
                        let _ = tx.send(outcome);
                    }
                    // No waiter means the request timed out and gave up. The
                    // reply is dropped rather than matched to anything else —
                    // ids are never reused, so it cannot belong to a live
                    // request.
                }
                Ok(Incoming::Event { method, params }) => {
                    if events.send((method, params)).is_err() {
                        // Nobody is listening for events any more, but replies
                        // may still matter, so this is not a reason to stop.
                    }
                }
                // A shape neither this build nor the protocol accounts for.
                // Logged at debug and ignored: an unknown message is not a
                // reason to tear down a working session.
                Ok(Incoming::Unknown(value)) => {
                    tracing::debug!(target: "tmuxy_server::browser", ?value, "unrecognised CDP message");
                }
                Err(error) => {
                    tracing::warn!(target: "tmuxy_server::browser", %error, "unreadable CDP message");
                }
            }
        }
    }

    // EOF: the engine is gone. Dropping every waiting sender turns each
    // in-flight request into `Gone` immediately instead of a 30s timeout.
    pending.lock().await.clear();
}

/// A unix pipe as two owned fds.
fn os_pipe() -> Result<(OwnedFd, OwnedFd), EngineError> {
    let mut fds = [0i32; 2];
    // SAFETY: `fds` is a two-element array, which is what pipe(2) writes.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(EngineError::Pipe(io::Error::last_os_error()));
    }
    // SAFETY: both fds were just created by pipe(2) and are not owned elsewhere.
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}
