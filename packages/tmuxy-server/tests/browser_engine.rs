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

    let saw_event = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        while let Some((method, _params)) = engine.events.recv().await {
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
