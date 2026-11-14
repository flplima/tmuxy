import { describe, expect, it } from 'vitest';
import { paneStateLabel, readPaneStatus } from '../paneStatus';

/** Base64 of UTF-8 text, as a program writes `msg` and `title`. */
function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

describe('readPaneStatus', () => {
  it('reads the record the host sent', () => {
    expect(
      readPaneStatus(
        `state=blocked:id=eu-west:kind=permission:progress=40:app=deploy:title=${b64('EU West')}:msg=${b64('Approve deploy to eu-west (produção)?')}`,
      ),
    ).toEqual({
      kind: 'permission',
      progress: 40,
      app: 'deploy',
      title: 'EU West',
      msg: 'Approve deploy to eu-west (produção)?',
    });
  });

  it('is nothing for a pane whose state is not a report', () => {
    expect(readPaneStatus(null)).toBeNull();
    expect(readPaneStatus(undefined)).toBeNull();
    expect(readPaneStatus('')).toBeNull();
  });

  it('reads text without its padding', () => {
    expect(readPaneStatus(`state=done:msg=${b64('Healthy').replace(/=+$/, '')}`)?.msg).toBe(
      'Healthy',
    );
  });

  it('drops text that is not one plain line', () => {
    for (const bad of ['first\nsecond', 'ding\u0007', 'csi\u009b31m']) {
      expect(readPaneStatus(`state=working:msg=${b64(bad)}`)?.msg).toBeUndefined();
    }
    expect(readPaneStatus('state=working:msg=!!not-base64!!')?.msg).toBeUndefined();
  });

  it('takes out the characters that reverse a line or hide in it', () => {
    const forged = 'Approve \u202egnp.exe\u202c\u200b now';
    expect(readPaneStatus(`state=blocked:msg=${b64(forged)}`)?.msg).toBe('Approve gnp.exe now');
  });

  it('shortens a long line', () => {
    const msg = readPaneStatus(`state=working:msg=${b64('x'.repeat(2000))}`)?.msg ?? '';
    expect(msg).toHaveLength(240);
    expect(msg.endsWith('…')).toBe(true);
  });

  it('ignores a kind or a progress outside the protocol', () => {
    const status = readPaneStatus('state=blocked:kind=coffee:progress=250');
    expect(status?.kind).toBeUndefined();
    expect(status?.progress).toBeUndefined();
  });
});

describe('paneStateLabel', () => {
  const blocked = `state=blocked:kind=question:msg=${b64('Which branch?')}`;

  it('is the state alone for a pane that reported nothing', () => {
    expect(paneStateLabel('working', { paneState: 'working', paneStatus: null })).toBe('Working');
  });

  it('says what a blocked program waits for, and why', () => {
    expect(paneStateLabel('needs-input', { paneState: 'needs-input', paneStatus: blocked })).toBe(
      'Needs your answer: Which branch?',
    );
  });

  it('adds how far along a working program is', () => {
    expect(
      paneStateLabel('working', {
        paneState: 'working',
        paneStatus: `state=working:progress=40:title=${b64('US East')}:msg=${b64('Pushing image')}`,
      }),
    ).toBe('Working 40%: US East: Pushing image');
  });

  it("keeps the program's words off a state that is not its own", () => {
    // A send's question raised the mark to needs-input over a working program.
    expect(
      paneStateLabel('needs-input', {
        paneState: 'working',
        paneStatus: `state=working:msg=${b64('Building')}`,
      }),
    ).toBe('Needs your input');
  });
});
