//! Driving a real browser over a real pipe.
//!
//! Everything else about the engine is unit-tested without one: the framing,
//! the reply correlation, the command line. None of that proves the pipe works,
//! because the part that can only be wrong in the real thing is the fd
//! placement — Chromium numbers its pipe fds from the CHILD's point of view,
//! and a parent that puts its halves anywhere but 3 and 4 gets a browser that
//! starts, says nothing, and times out. No unit test can see that.
//!
//! So this launches the engine the server would launch and asks it real
//! questions. It SKIPS when there is no browser on the machine rather than
//! failing: the feature is explicitly "the user's own engine, or no feature",
//! and a CI job without one should not go red over a browser nobody installed.
//! The skip is loud (`eprintln!` + the reason), because a silent skip is how a
//! suite reports green for tests that never ran.

#![allow(clippy::unwrap_used, clippy::expect_used)]
#![cfg(unix)]

use std::path::{Path, PathBuf};
use tmuxy_server::browser::{discover, engine, process::Engine};

/// A scratch state dir of this test's own, cleaned up after.
fn scratch_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tmuxy-engine-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

/// The browser to drive, or None with the reason printed.
fn browser_or_skip(test: &str) -> Option<PathBuf> {
    match discover::find_browser() {
        Ok(path) => Some(path),
        Err(why) => {
            eprintln!("SKIP {test}: {why}");
            None
        }
    }
}

/// Launch an engine on a profile under `state`, or skip.
async fn launch(test: &str, state: &Path) -> Option<Engine> {
    let browser = browser_or_skip(test)?;
    let profile = engine::profile_dir(state, "test");
    match Engine::launch(&browser, &profile).await {
        Ok(engine) => Some(engine),
        Err(why) => {
            // A launch failure is NOT a skip — the browser exists and would
            // not start, which is the thing worth failing over.
            panic!("{test}: could not launch {}: {why}", browser.display());
        }
    }
}

/// The fd placement, end to end: if the pipe halves are not at 3 and 4 in the
/// child, this times out and nothing else in the file can pass either.
#[tokio::test]
async fn the_engine_answers_over_the_pipe() {
    let state = scratch_dir("version");
    let Some(mut engine) = launch("the_engine_answers_over_the_pipe", &state).await else {
        return;
    };

    let version = engine
        .send("Browser.getVersion", serde_json::json!({}))
        .await
        .expect("Browser.getVersion");

    let product = version
        .get("product")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    assert!(
        product.contains('/'),
        "a product string looks like `HeadlessChrome/120.0.0.0`, got {product:?}"
    );

    engine.shutdown().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// A page is navigated and read back. This is the shape every REPL verb takes,
/// so it is the one that proves the transport carries real work rather than a
/// single handshake.
#[tokio::test]
async fn a_page_can_be_navigated_and_read_back() {
    let state = scratch_dir("navigate");
    let Some(mut engine) = launch("a_page_can_be_navigated_and_read_back", &state).await else {
        return;
    };

    // A data: URL rather than a server or a file: the subject is the transport,
    // and a test that needs a listening socket to prove a pipe works has two
    // things that can fail.
    let html = "data:text/html,<title>Pipe%20OK</title><h1>hello%20from%20tmuxy</h1>";
    engine
        .send("Page.enable", serde_json::json!({}))
        .await
        .expect("Page.enable");
    engine
        .send("Page.navigate", serde_json::json!({ "url": html }))
        .await
        .expect("Page.navigate");

    // Poll for the document rather than sleeping: navigation completes on its
    // own schedule, and a fixed wait is a constant that encodes how fast the
    // machine is.
    let mut heading = String::new();
    for _ in 0..100 {
        let result = engine
            .send(
                "Runtime.evaluate",
                serde_json::json!({
                    "expression": "document.querySelector('h1')?.textContent ?? ''",
                    "returnByValue": true,
                }),
            )
            .await
            .expect("Runtime.evaluate");
        heading = result
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        if !heading.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    assert_eq!(heading, "hello from tmuxy");

    engine.shutdown().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// A failing command must come back as a protocol error naming the method, not
/// as a timeout. The REPL prints these to the user, so the difference between
/// "your selector was wrong" and "nothing happened for 30 seconds" is the
/// difference between a usable tool and an opaque one.
#[tokio::test]
async fn a_bad_command_fails_fast_and_says_what_failed() {
    let state = scratch_dir("error");
    let Some(mut engine) = launch("a_bad_command_fails_fast_and_says_what_failed", &state).await
    else {
        return;
    };

    // Warm up first: the engine is still starting when `launch` returns, and
    // measuring the first request would measure Chromium's start-up, not how
    // fast an error comes back.
    engine
        .send_browser("Browser.getVersion", serde_json::json!({}))
        .await
        .expect("warm-up");

    let started = std::time::Instant::now();
    let error = engine
        .send("Totally.NotAMethod", serde_json::json!({}))
        .await
        .expect_err("an unknown method must fail");

    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "an unknown method should fail immediately, took {:?}",
        started.elapsed()
    );
    let message = error.to_string();
    assert!(
        message.contains("Totally.NotAMethod"),
        "the error must name the method that failed: {message}"
    );

    engine.shutdown().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// Events arrive on their own, without being asked for. The screencast and the
/// console mirror both ride this channel, so "replies work" is not enough.
#[tokio::test]
async fn events_arrive_without_being_asked_for() {
    let state = scratch_dir("events");
    let Some(mut engine) = launch("events_arrive_without_being_asked_for", &state).await else {
        return;
    };

    engine
        .send("Page.enable", serde_json::json!({}))
        .await
        .expect("Page.enable");
    engine
        .send(
            "Page.navigate",
            serde_json::json!({ "url": "data:text/html,<p>x</p>" }),
        )
        .await
        .expect("Page.navigate");

    // Taken rather than borrowed: there is one event stream, and `Session`
    // takes it for the screencast pump in normal use.
    let mut events = engine.take_events().expect("the event stream is unclaimed");
    let saw_event = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        while let Some((method, _params)) = events.recv().await {
            if method.starts_with("Page.") {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);

    assert!(saw_event, "no Page.* event arrived after a navigation");

    engine.shutdown().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// The profile lock is the one failure that outlives a session: a half-dead
/// engine holding it means the NEXT session with that name cannot start. So
/// shutting down and relaunching on the same profile has to work.
#[tokio::test]
async fn a_profile_is_reusable_after_a_clean_shutdown() {
    let state = scratch_dir("relaunch");
    let Some(mut first) = launch("a_profile_is_reusable_after_a_clean_shutdown", &state).await
    else {
        return;
    };
    first
        .send("Browser.getVersion", serde_json::json!({}))
        .await
        .expect("the first engine answers");
    first.shutdown().await;

    let browser = discover::find_browser().expect("a browser was found a moment ago");
    let profile = engine::profile_dir(&state, "test");
    let mut second = Engine::launch(&browser, &profile)
        .await
        .expect("the profile must be usable again after a clean shutdown");
    second
        .send("Browser.getVersion", serde_json::json!({}))
        .await
        .expect("the second engine answers");
    second.shutdown().await;

    let _ = std::fs::remove_dir_all(&state);
}

// ===========================================================================
// The session layer: verbs against a real page
// ===========================================================================
//
// `Engine` carries CDP; `Session` is the verbs built on it, and those are what
// a user and an agent actually invoke. The interesting ones cannot be
// unit-tested, because what they assert is how a real page reacts: that a
// framework sees the text `type` entered, that `click` works on an element
// nothing has scrolled into view, that `wait` returns when an element appears
// rather than when a timer expires.

/// A page with the shapes the verbs are about, as a `data:` URL — so the test
/// needs no listening socket to prove something about a browser.
fn fixture_page() -> String {
    let html = "\
<title>Verb Fixture</title>\
<h1>Heading</h1>\
<input id=\"field\">\
<button id=\"go\" onclick=\"document.querySelector('#out').textContent='clicked'\">Go</button>\
<p id=\"out\"></p>\
<p id=\"hidden\" style=\"display:none\">invisible</p>\
<script>\
document.querySelector('#field').addEventListener('input', e => {\
  document.querySelector('#out').dataset.sawInput = e.target.value;\
});\
setTimeout(() => {\
  const late = document.createElement('div');\
  late.id = 'late';\
  late.textContent = 'arrived';\
  document.body.appendChild(late);\
}, 700);\
</script>";
    format!("data:text/html,{}", urlencode(html))
}

/// Percent-encode what a `data:` URL cannot carry literally.
fn urlencode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'~'
            | b'!'
            | b'*'
            | b'\''
            | b'('
            | b')'
            | b';'
            | b':'
            | b'@'
            | b'='
            | b'+'
            | b'$'
            | b','
            | b'/'
            | b'?'
            | b'['
            | b']'
            | b'<'
            | b'>'
            | b'{'
            | b'}'
            | b'|'
            | b'^'
            | b'`' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Start a session on a scratch state dir, or skip.
async fn session_or_skip(
    test: &str,
    state: &Path,
) -> Option<tmuxy_server::browser::session::Session> {
    if browser_or_skip(test).is_none() {
        return None;
    }
    match tmuxy_server::browser::session::Session::start(state, "verbs").await {
        Ok(session) => Some(session),
        Err(why) => panic!("{test}: could not start a session: {why}"),
    }
}

/// Every verb that reads something, against one page.
///
/// One test rather than six, because they share a page load and the load is
/// most of the cost — and because "one feature, one test" (docs/TESTS.md) is
/// about a feature, which here is the verb vocabulary.
#[tokio::test]
async fn the_reading_verbs_answer_from_a_real_page() {
    use tmuxy_server::browser::session::Output;
    use tmuxy_server::browser::verbs::Verb;

    let state = scratch_dir("verbs-read");
    let Some(mut session) =
        session_or_skip("the_reading_verbs_answer_from_a_real_page", &state).await
    else {
        return;
    };

    let landed = session
        .run(Verb::Goto {
            url: fixture_page(),
        })
        .await
        .expect("goto");
    assert!(
        matches!(&landed, Output::Line(url) if url.starts_with("data:text/html,")),
        "goto echoes where it landed, got {landed:?}"
    );

    assert_eq!(
        session.run(Verb::Title).await.expect("title"),
        Output::Line("Verb Fixture".to_string())
    );

    assert_eq!(
        session
            .run(Verb::Text {
                selector: Some("h1".to_string())
            })
            .await
            .expect("text h1"),
        Output::Text("Heading".to_string())
    );

    // innerText, not textContent: a hidden element says nothing, and the
    // `<script>` body must not appear in the page's text either.
    let body = session
        .run(Verb::Text { selector: None })
        .await
        .expect("text");
    let body = body.to_string();
    assert!(
        body.contains("Heading"),
        "the visible text is there: {body:?}"
    );
    assert!(
        !body.contains("invisible"),
        "a display:none element is not visible text: {body:?}"
    );
    assert!(
        !body.contains("addEventListener"),
        "a script body is not page text: {body:?}"
    );

    assert_eq!(
        session
            .run(Verb::Eval {
                expression: "6 * 7".to_string()
            })
            .await
            .expect("eval"),
        Output::Line("42".to_string())
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// The verbs that change the page. `type` is the one with a trap: setting
/// `.value` alone is invisible to anything tracking state from events, so the
/// fixture records what its `input` listener actually saw.
#[tokio::test]
async fn the_acting_verbs_change_a_real_page() {
    use tmuxy_server::browser::session::Output;
    use tmuxy_server::browser::verbs::Verb;

    let state = scratch_dir("verbs-act");
    let Some(mut session) = session_or_skip("the_acting_verbs_change_a_real_page", &state).await
    else {
        return;
    };
    session
        .run(Verb::Goto {
            url: fixture_page(),
        })
        .await
        .expect("goto");

    session
        .run(Verb::Type {
            selector: "#field".to_string(),
            text: "hello there".to_string(),
        })
        .await
        .expect("type");

    assert_eq!(
        session
            .run(Verb::Eval {
                expression: "document.querySelector('#field').value".to_string()
            })
            .await
            .expect("read the field"),
        Output::Line("hello there".to_string()),
        "the field holds the text"
    );
    assert_eq!(
        session
            .run(Verb::Eval {
                expression: "document.querySelector('#out').dataset.sawInput".to_string()
            })
            .await
            .expect("read the listener's record"),
        Output::Line("hello there".to_string()),
        "a framework listening for `input` must have seen it — assigning .value \
         alone leaves the app unaware of text the user can see"
    );

    session
        .run(Verb::Click {
            selector: "#go".to_string(),
        })
        .await
        .expect("click");
    assert_eq!(
        session
            .run(Verb::Text {
                selector: Some("#out".to_string())
            })
            .await
            .expect("read the click's effect"),
        Output::Text("clicked".to_string())
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// `wait` must return when the element appears, not when a timer expires. The
/// fixture adds `#late` after 700ms, so a `wait` that returned immediately or
/// only after its full 20s budget would both be wrong.
#[tokio::test]
async fn wait_returns_when_the_element_arrives() {
    use tmuxy_server::browser::verbs::Verb;

    let state = scratch_dir("verbs-wait");
    let Some(mut session) = session_or_skip("wait_returns_when_the_element_arrives", &state).await
    else {
        return;
    };
    session
        .run(Verb::Goto {
            url: fixture_page(),
        })
        .await
        .expect("goto");

    // Not there yet when the page has just settled.
    let started = std::time::Instant::now();
    session
        .run(Verb::Wait {
            selector: "#late".to_string(),
        })
        .await
        .expect("wait");
    let waited = started.elapsed();

    assert!(
        waited < std::time::Duration::from_secs(15),
        "wait should return when the element arrives, not at its budget: {waited:?}"
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// A selector that matches nothing is a named error, not a silent success. An
/// agent that cannot tell "clicked" from "there was nothing to click" will act
/// on the wrong belief.
#[tokio::test]
async fn a_verb_on_a_missing_element_says_so() {
    use tmuxy_server::browser::verbs::Verb;

    let state = scratch_dir("verbs-missing");
    let Some(mut session) = session_or_skip("a_verb_on_a_missing_element_says_so", &state).await
    else {
        return;
    };
    session
        .run(Verb::Goto {
            url: fixture_page(),
        })
        .await
        .expect("goto");

    let error = session
        .run(Verb::Click {
            selector: "#nothing-like-this".to_string(),
        })
        .await
        .expect_err("clicking nothing must fail");
    assert!(
        error.to_string().contains("#nothing-like-this"),
        "the error names the selector: {error}"
    );

    // And a page that throws reports what it threw, not a transport failure.
    let thrown = session
        .run(Verb::Eval {
            expression: "definitelyNotDefined()".to_string(),
        })
        .await
        .expect_err("a throwing expression must fail");
    assert!(
        thrown.to_string().contains("definitelyNotDefined"),
        "the page's own error survives: {thrown}"
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// A screenshot is a real PNG on disk. Checked by its magic bytes rather than
/// its size: a zero-byte file and a base64 decode that silently produced
/// garbage would both pass a "the file exists" assertion.
#[tokio::test]
async fn a_screenshot_is_a_png_on_disk() {
    use tmuxy_server::browser::session::Output;
    use tmuxy_server::browser::verbs::Verb;

    let state = scratch_dir("verbs-shot");
    let Some(mut session) = session_or_skip("a_screenshot_is_a_png_on_disk", &state).await else {
        return;
    };
    session
        .run(Verb::Goto {
            url: fixture_page(),
        })
        .await
        .expect("goto");

    let target = state.join("shot.png");
    let printed = session
        .run(Verb::Shot {
            path: Some(target.display().to_string()),
        })
        .await
        .expect("shot");
    assert_eq!(printed, Output::Line(target.display().to_string()));

    let bytes = std::fs::read(&target).expect("the screenshot exists");
    assert_eq!(
        &bytes[..8],
        b"\x89PNG\r\n\x1a\n",
        "the file must be a real PNG, not an empty or mis-decoded one"
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}

// ===========================================================================
// The screencast: a picture of the page, for the pane
// ===========================================================================

/// A session nobody has navigated still produces a frame.
///
/// This is the case that broke twice while building it, both times silently.
/// Chromium emits a screencast frame only when the page CHANGES visually, so a
/// page someone has opened to READ produces nothing at all — and a `watch`
/// channel's `send` throws the value away when no receiver is attached yet, so
/// even the explicit first frame went missing. Either bug alone leaves a blank
/// pane and no error anywhere.
#[tokio::test]
async fn a_still_page_still_produces_a_frame() {
    let state = scratch_dir("screencast-still");
    let Some(mut session) = session_or_skip("a_still_page_still_produces_a_frame", &state).await
    else {
        return;
    };

    // Deliberately NOT navigated: `about:blank` is as static as a page gets.
    let mut frames = session.watch_frames().await.expect("watch_frames");
    let frame = frames.borrow_and_update().clone();

    assert!(
        !frame.is_empty(),
        "a subscriber must be handed the current frame, not an empty one — a page \
         that never changes produces no screencast event, so the first frame has \
         to be captured explicitly AND retained for whoever connects next"
    );
    assert_eq!(
        &frame[..3],
        b"\xff\xd8\xff",
        "the frame must be a JPEG (SOI marker), not an empty or mis-decoded buffer"
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// A page that changes keeps producing frames, which is the acknowledgement
/// working: Chromium sends up to a small number of unacknowledged frames and
/// then stops, so a pump that published without acking would show the first few
/// and then a still picture — looking like the page had stopped, not the stream.
#[tokio::test]
async fn a_changing_page_keeps_producing_frames() {
    use tmuxy_server::browser::verbs::Verb;

    let state = scratch_dir("screencast-moving");
    let Some(mut session) = session_or_skip("a_changing_page_keeps_producing_frames", &state).await
    else {
        return;
    };

    let mut frames = session.watch_frames().await.expect("watch_frames");
    session
        .run(Verb::Goto {
            url: format!(
                "data:text/html,{}",
                urlencode(
                    "<body><h1 id=n>0</h1><script>let n=0;\
                     setInterval(()=>{n++;document.getElementById('n').textContent=n;\
                     document.body.style.background=n%2?'#123':'#321'},120)</script></body>"
                )
            ),
        })
        .await
        .expect("goto");

    // Count distinct frames rather than events: an implementation that stopped
    // after its unacknowledged allowance would deliver a handful and stall.
    let mut seen = 0;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
    while std::time::Instant::now() < deadline && seen < 8 {
        if tokio::time::timeout(std::time::Duration::from_secs(3), frames.changed())
            .await
            .is_err()
        {
            break;
        }
        if !frames.borrow_and_update().is_empty() {
            seen += 1;
        }
    }

    assert!(
        seen >= 8,
        "only {seen} frames arrived; Chromium stops sending once its unacknowledged \
         allowance is used up, so this is what a missing Page.screencastFrameAck \
         looks like"
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// The viewport is what the PAGE lays out against, so the pane's size has to
/// reach it — and a nonsense size has to be refused rather than clamped: a pane
/// mid-resize reports 0, and a viewport of 0 makes Chromium stop painting
/// altogether, which is indistinguishable from the feature being broken.
#[tokio::test]
async fn the_viewport_follows_the_pane_and_refuses_nonsense() {
    use tmuxy_server::browser::session::Output;
    use tmuxy_server::browser::verbs::Verb;

    let state = scratch_dir("viewport");
    let Some(mut session) =
        session_or_skip("the_viewport_follows_the_pane_and_refuses_nonsense", &state).await
    else {
        return;
    };

    session
        .set_viewport(480, 800, 1.0)
        .await
        .expect("set_viewport");
    assert_eq!(
        session
            .run(Verb::Eval {
                expression: "innerWidth + 'x' + innerHeight".to_string()
            })
            .await
            .expect("read the viewport"),
        Output::Line("480x800".to_string()),
        "the page must lay out at the size it was given"
    );

    for (w, h) in [(0, 800), (480, 0), (99_999, 800)] {
        assert!(
            session.set_viewport(w, h, 1.0).await.is_err(),
            "{w}x{h} must be refused, not clamped"
        );
    }
    // And the refusal left the usable one in place.
    assert_eq!(
        session
            .run(Verb::Eval {
                expression: "innerWidth".to_string()
            })
            .await
            .expect("viewport survived"),
        Output::Line("480".to_string())
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// Forwarded input reaches the page, and only the three `Input` methods a pane
/// needs may be named.
///
/// The allowlist is the security half: `method` and `params` come from a
/// client, so without it this would be a general door into CDP — where
/// `Runtime.evaluate` runs anything and `Page.navigate` goes anywhere.
#[tokio::test]
async fn forwarded_input_reaches_the_page_and_nothing_else_does() {
    use tmuxy_server::browser::session::Output;
    use tmuxy_server::browser::verbs::Verb;

    let state = scratch_dir("input");
    let Some(mut session) = session_or_skip(
        "forwarded_input_reaches_the_page_and_nothing_else_does",
        &state,
    )
    .await
    else {
        return;
    };

    session.set_viewport(800, 600, 1.0).await.expect("viewport");
    session
        .run(Verb::Goto {
            url: format!(
                "data:text/html,{}",
                urlencode(
                    "<body style='margin:0'><div id=hit style='width:400px;height:200px'></div>\
                     <p id=out>none</p>\
                     <script>document.getElementById('hit')\
                     .addEventListener('click',()=>{document.getElementById('out').textContent='hit'});\
                     document.addEventListener('keydown',e=>{\
                     document.getElementById('out').textContent='key:'+e.key})</script></body>"
                )
            ),
        })
        .await
        .expect("goto");

    // A click, as the pane forwards one: press then release at the same point.
    for phase in ["mousePressed", "mouseReleased"] {
        session
            .forward_input(
                "Input.dispatchMouseEvent",
                serde_json::json!({
                    "type": phase,
                    "x": 100, "y": 60,
                    "button": "left",
                    "buttons": if phase == "mousePressed" { 1 } else { 0 },
                    "clickCount": 1,
                }),
            )
            .await
            .unwrap_or_else(|e| panic!("forward {phase}: {e}"));
    }
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert_eq!(
        session
            .run(Verb::Text {
                selector: Some("#out".to_string())
            })
            .await
            .expect("read the click's effect"),
        Output::Text("hit".to_string()),
        "a press and release forwarded from the pane must land as a click"
    );

    // A key, likewise.
    session
        .forward_input(
            "Input.dispatchKeyEvent",
            serde_json::json!({ "type": "keyDown", "key": "q", "text": "q" }),
        )
        .await
        .expect("forward a key");
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert_eq!(
        session
            .run(Verb::Text {
                selector: Some("#out".to_string())
            })
            .await
            .expect("read the key's effect"),
        Output::Text("key:q".to_string())
    );

    // And the door is only this wide.
    for method in [
        "Runtime.evaluate",
        "Page.navigate",
        "Browser.close",
        "Input.setInterceptDrags",
        "Input.dispatchTouchEvent",
    ] {
        let refused = session
            .forward_input(method, serde_json::json!({}))
            .await
            .expect_err(method);
        assert!(
            refused.to_string().contains(method),
            "the refusal names what was refused: {refused}"
        );
    }

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}
