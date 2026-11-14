/**
 * The budget for `perf:hidden-bytes` reports, which `compare-interactions.mjs`
 * hands here: what a pane redrawing a spinner in a tab nobody shows adds to
 * the event stream, per byte it printed. A ratio of bytes, so it means the
 * same on any machine.
 */

/**
 * The most a hidden spinner may add to the stream per byte it prints.
 * Measured ~0.35 since a hidden pane's screen goes at most once a second
 * (`state::hidden_panes`); it was ~8, every frame sent in full.
 */
export const HIDDEN_PER_SPINNER_BYTE_BUDGET = 1;

/** The report's table and what is over budget. */
export function compareHiddenBytes(report) {
  const { quiet, hidden, visible } = report.streamBytesPerSecond;
  const failures = [];
  if (report.hiddenPerSpinnerByte > HIDDEN_PER_SPINNER_BYTE_BUDGET) {
    failures.push(
      `a hidden spinner adds ${report.hiddenPerSpinnerByte} B to the stream per byte it prints ` +
        `(budget ${HIDDEN_PER_SPINNER_BYTE_BUDGET})`,
    );
  }
  const lines = [
    `### Event-stream bytes for a hidden pane — \`${report.target}\``,
    '',
    '| | stream B/s | per spinner byte | budget |',
    '| --- | --- | --- | --- |',
    `| quiet | ${quiet} | | |`,
    `| hidden spinner | ${hidden} | ${report.hiddenPerSpinnerByte} | ${HIDDEN_PER_SPINNER_BYTE_BUDGET} |`,
    `| visible spinner | ${visible} | ${report.visiblePerSpinnerByte} | |`,
    '',
    `The spinner printed ${report.spinnerBytesPerSecond} B/s over ${report.seconds} s.`,
  ];
  if (failures.length) lines.push('', '**Over budget**', ...failures.map((f) => `- ${f}`));
  return { lines, failures };
}
