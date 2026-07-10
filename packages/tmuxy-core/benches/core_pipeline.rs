//! Axis-A benchmark: the client-side / core processing pipeline, measured
//! natively but exercising the EXACT code that runs in the browser via
//! `tmuxy-wasm` (Parser + StateAggregator + to_state_update — one source of
//! truth, no VT reimplementation). This is the "how fast is our code with the
//! network removed" baseline described in docs/PERFORMANCE.md.
//!
//! Three groups:
//! - `full_sync`: cold parse of the first sync block → first FULL snapshot.
//! - `delta_rename`: one single-field change on a synced session → DELTA.
//! - `output_burst`: a `seq 1 N` flood of %output events → vt100 feed + delta,
//!   reported as bytes/sec throughput.
//!
//! Run: `cargo bench -p tmuxy-core`

use std::time::Duration;

use criterion::{criterion_group, criterion_main, BatchSize, BenchmarkId, Criterion, Throughput};
use std::hint::black_box;

use tmuxy_core::control_mode::{ControlModeEvent, Parser, StateAggregator};

/// The initial control-mode stream establishing a 2-pane session — the same
/// fixture the DeltaProtocol Storybook story feeds the wasm core. The
/// aggregator reports this as a FULL state.
const FULL_SYNC: &str = concat!(
    "%begin 1 1 0\n",
    "%end 1 1 0\n",
    "%session-changed $0 m\n",
    "%window-add @0\n",
    "%begin 2 2 1\n",
    "%0,0,0,0,40,24,0,0,1,zsh,,0,0,0,0,@0,,0,0,0,0,0,100\n",
    "%1,1,41,0,39,24,0,0,0,zsh,,0,0,0,0,@0,,0,0,0,0,0,100\n",
    "%end 2 2 1\n",
    "%layout-change @0 8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1} ",
    "8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1} *\n",
);

/// Replicate the wasm `Session::feed` line loop: split on newlines, strip the
/// trailing CR/LF, parse, and step the aggregator. Returns nothing — callers
/// pull the update via `to_state_update` so timing includes snapshot/delta
/// serialization-shaping, which is what actually reaches the wire.
fn feed_lines(parser: &mut Parser, agg: &mut StateAggregator, text: &str) {
    for raw in text.split('\n') {
        if raw.is_empty() {
            continue;
        }
        let line = raw.trim_end_matches(['\r', '\n']);
        if let Some(event) = parser.parse_line(line) {
            let _ = agg.step(event);
        }
    }
}

/// A parser + aggregator already advanced past the first full sync — the
/// realistic starting point for delta/burst measurements.
fn synced_session() -> (Parser, StateAggregator) {
    let mut parser = Parser::new();
    let mut agg = StateAggregator::with_session_name("m");
    feed_lines(&mut parser, &mut agg, FULL_SYNC);
    let _ = agg.to_state_update();
    (parser, agg)
}

/// A `seq`-style burst of `%output` events for pane %0, one line each.
fn output_burst(lines: usize) -> Vec<ControlModeEvent> {
    (0..lines)
        .map(|i| ControlModeEvent::Output {
            pane_id: "%0".to_string(),
            content: format!("{i}: the quick brown fox jumps over the lazy dog\r\n").into_bytes(),
        })
        .collect()
}

fn bench_full_sync(c: &mut Criterion) {
    c.bench_function("full_sync", |b| {
        b.iter(|| {
            let mut parser = Parser::new();
            let mut agg = StateAggregator::with_session_name("m");
            feed_lines(&mut parser, &mut agg, black_box(FULL_SYNC));
            black_box(agg.to_state_update());
        });
    });
}

fn bench_delta_rename(c: &mut Criterion) {
    c.bench_function("delta_rename", |b| {
        b.iter_batched(
            synced_session,
            |(mut parser, mut agg)| {
                feed_lines(
                    &mut parser,
                    &mut agg,
                    black_box("%window-renamed @0 renamed\n"),
                );
                black_box(agg.to_state_update());
            },
            BatchSize::SmallInput,
        );
    });
}

fn bench_output_burst(c: &mut Criterion) {
    let mut group = c.benchmark_group("output_burst");
    // A representative flood size (`seq 1 2000` is the ThroughputSustained
    // story's workload) plus a smaller point to see per-event scaling.
    for &lines in &[200usize, 2000usize] {
        let events = output_burst(lines);
        let bytes: u64 = events
            .iter()
            .map(|e| match e {
                ControlModeEvent::Output { content, .. } => content.len() as u64,
                _ => 0,
            })
            .sum();
        group.throughput(Throughput::Bytes(bytes));
        group.bench_with_input(BenchmarkId::from_parameter(lines), &events, |b, events| {
            b.iter_batched(
                || (synced_session(), events.clone()),
                |((_parser, mut agg), events)| {
                    for event in events {
                        let _ = agg.step(black_box(event));
                    }
                    black_box(agg.to_state_update());
                },
                BatchSize::SmallInput,
            );
        });
    }
    group.finish();
}

criterion_group! {
    name = benches;
    // Keep CI wall-clock modest; the numbers are for regression tracking, not
    // publication-grade precision.
    config = Criterion::default().measurement_time(Duration::from_secs(3));
    targets = bench_full_sync, bench_delta_rename, bench_output_burst
}
criterion_main!(benches);
