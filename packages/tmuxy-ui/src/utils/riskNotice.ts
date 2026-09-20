/**
 * The first-run notice: what tmuxy is (alpha, largely AI-written) and what it
 * can do (it is a remote control for a shell). Shown until acknowledged with
 * "don't show this again"; the acknowledgement lives in this browser only.
 */

const LS_KEY = 'tmuxy-risk-notice-ack';

export function riskNoticeAcknowledged(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === '1';
  } catch {
    // No storage (private mode, a sandboxed frame): ask every time.
    return false;
  }
}

export function acknowledgeRiskNotice(): void {
  try {
    localStorage.setItem(LS_KEY, '1');
  } catch {
    // No storage: the notice comes back next time, which is the safe failure.
  }
}
