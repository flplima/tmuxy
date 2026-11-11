import { describe, expect, it } from 'vitest';
import { portUrl, portsByPane } from '../panePorts';

describe('a pane’s ports', () => {
  it('are found by pane', () => {
    const byPane = portsByPane([
      { paneId: '%1', ports: [5173, 24678] },
      { paneId: '%4', ports: [8123] },
    ]);
    expect(byPane.get('%1' as never)).toEqual([5173, 24678]);
    expect(byPane.get('%2' as never)).toBeUndefined();
  });

  it('open on the host the page came from, or this machine', () => {
    expect(portUrl(8123, null)).toBe('http://localhost:8123/');
    expect(portUrl(8123, 'localhost')).toBe('http://localhost:8123/');
    expect(portUrl(5173, 'devbox.lan')).toBe('http://devbox.lan:5173/');
    expect(portUrl(80, '192.168.0.9')).toBe('http://192.168.0.9:80/');
    // An IPv6 host goes in brackets, or the port would read as part of it.
    expect(portUrl(8123, '::1')).toBe('http://[::1]:8123/');
  });
});
