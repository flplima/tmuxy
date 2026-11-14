import { describe, it, expect, beforeEach } from 'vitest';
import { estimateRoundTrip, linkLatency, slowLink } from '../linkLatency';

describe('the link round trip', () => {
  it('is the fastest recent answer: a slow command is the link plus its own work', () => {
    // Keystrokes over a 170 ms link, with a full state (a 750 ms wait for a
    // resize) and a scrollback read among them.
    expect(estimateRoundTrip([172, 171, 930, 174, 2400, 173])).toBe(171);
  });

  it('is not guessed from one or two answers', () => {
    expect(estimateRoundTrip([])).toBeNull();
    expect(estimateRoundTrip([400, 410])).toBeNull();
  });
});

describe('a slow link', () => {
  it('is not reported on loopback or a LAN', () => {
    expect(slowLink(null)).toBeNull();
    expect(slowLink(1.2)).toBeNull();
    expect(slowLink(99)).toBeNull();
  });

  it('is reported from 100 ms, rounded so it does not flicker, and marked very slow from 300 ms', () => {
    expect(slowLink(100)).toEqual({ ms: 100, level: 'slow' });
    expect(slowLink(173)).toEqual({ ms: 170, level: 'slow' });
    expect(slowLink(299)).toEqual({ ms: 300, level: 'slow' });
    expect(slowLink(304)).toEqual({ ms: 300, level: 'very-slow' });
  });
});

describe('linkLatency', () => {
  beforeEach(() => linkLatency.reset());

  it('tells its subscribers when the link turns slow, and not for every answer after', () => {
    let told = 0;
    const unsubscribe = linkLatency.subscribe(() => told++);

    for (const ms of [171, 172, 174]) linkLatency.record(ms);
    expect(linkLatency.getSnapshot()).toEqual({ ms: 170, level: 'slow' });
    expect(told).toBe(1);

    for (const ms of [173, 170, 174, 900]) linkLatency.record(ms);
    expect(told).toBe(1);
    unsubscribe();
  });

  it('forgets a slow link once the answers come back fast: the laptop is home again', () => {
    for (const ms of [171, 172, 174]) linkLatency.record(ms);
    expect(linkLatency.getSnapshot()).not.toBeNull();
    // One fast answer is enough: the link cannot be slower than its fastest.
    linkLatency.record(2);
    expect(linkLatency.getSnapshot()).toBeNull();
  });

  it('forgets everything on a new connection', () => {
    for (const ms of [171, 172, 174]) linkLatency.record(ms);
    linkLatency.reset();
    expect(linkLatency.getSnapshot()).toBeNull();
    linkLatency.record(171);
    expect(linkLatency.getSnapshot()).toBeNull();
  });
});
