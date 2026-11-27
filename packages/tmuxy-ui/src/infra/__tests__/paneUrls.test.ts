import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVATION_WINDOW_MS,
  openPaneUrl,
  PaneUrlGate,
  paneUrlNotice,
  RATE_MAX,
  RATE_WINDOW_MS,
  trackUserActivation,
} from '../paneUrls';

/**
 * A program in a pane can ask for a URL at any moment (`$BROWSER`): it opens
 * with no notice only right after the person used the app, once per use, and
 * never past the rate limit.
 */
describe('PaneUrlGate', () => {
  const url = 'https://example.com/artifact';

  it('opens right after a click or key, and offers a notice otherwise', () => {
    const gate = new PaneUrlGate();
    expect(gate.decide(url, 1_000)).toBe('notice');
    gate.noteActivation(10_000);
    expect(gate.decide(url, 10_000 + ACTIVATION_WINDOW_MS)).toBe('open');
    gate.noteActivation(20_000);
    expect(gate.decide(url, 20_000 + ACTIVATION_WINDOW_MS + 1)).toBe('notice');
  });

  it('opens one URL per interaction: the next one from the same click is a notice', () => {
    const gate = new PaneUrlGate();
    gate.noteActivation(0);
    expect(gate.decide(url, 10)).toBe('open');
    expect(gate.decide(url, 20)).toBe('notice');
  });

  it('drops what a link could not open', () => {
    const gate = new PaneUrlGate();
    gate.noteActivation(0);
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'https://e.com/ x']) {
      expect(gate.decide(bad, 1)).toBe('drop');
    }
    // A refused one did not use the interaction up.
    expect(gate.decide(url, 2)).toBe('open');
  });

  it('drops past the rate limit until the window moves on', () => {
    const gate = new PaneUrlGate();
    for (let i = 0; i < RATE_MAX; i++) expect(gate.decide(url, i)).toBe('notice');
    expect(gate.decide(url, RATE_MAX)).toBe('drop');
    gate.noteActivation(RATE_MAX + 1);
    expect(gate.decide(url, RATE_MAX + 2)).toBe('drop');
    expect(gate.decide(url, RATE_WINDOW_MS + 1)).toBe('notice');
  });
});

describe('openPaneUrl', () => {
  afterEach(() => vi.restoreAllMocks());

  const keyPress = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));

  it('opens a new tab after a key in the page, and says nothing', () => {
    const untrack = trackUserActivation();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const say = vi.fn();
    keyPress();
    openPaneUrl('https://example.com/now', say);
    expect(open).toHaveBeenCalledWith('https://example.com/now', '_blank', 'noopener,noreferrer');
    expect(say).not.toHaveBeenCalled();
    untrack();
  });

  it('shows the URL with an Open button when nobody used the app just now', () => {
    const untrack = trackUserActivation();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const say = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER / 2);
    openPaneUrl('https://example.com/later', say);
    expect(open).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(paneUrlNotice('https://example.com/later'));
    expect(paneUrlNotice('https://example.com/later')).toMatchObject({
      kind: 'info',
      openUrl: 'https://example.com/later',
    });
    untrack();
  });

  it('shows the notice when the browser would refuse the tab', () => {
    const untrack = trackUserActivation();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    Object.defineProperty(navigator, 'userActivation', {
      configurable: true,
      value: { isActive: false, hasBeenActive: true },
    });
    const say = vi.fn();
    keyPress();
    openPaneUrl('https://example.com/blocked', say);
    expect(open).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(paneUrlNotice('https://example.com/blocked'));
    Reflect.deleteProperty(navigator, 'userActivation');
    untrack();
  });
});
