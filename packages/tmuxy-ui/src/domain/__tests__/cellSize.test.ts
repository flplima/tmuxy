import { describe, it, expect } from 'vitest';
import { cellSizeClaim, formatCellPx, parseCellPx, scaleToAnnounced } from '../cellSize';

describe('the announced cell size', () => {
  it('is written with up to two decimals and read back the same', () => {
    expect(formatCellPx(9, 24)).toBe('9x24');
    expect(formatCellPx(8.5, 17)).toBe('8.5x17');
    expect(formatCellPx(8.53333, 18.0001)).toBe('8.53x18');
    expect(parseCellPx('8.5x17')).toEqual({ width: 8.5, height: 17 });
    for (const bad of [
      '',
      'x',
      '9',
      '0x24',
      '9x0',
      '9x24x1',
      '-9x24',
      '9.x24',
      '9.123x24',
      ' 9x24',
    ]) {
      expect(parseCellPx(bad), bad).toBeNull();
    }
  });

  // Two clients, A drawing 9 by 24 and B 10 by 26, and the one option they
  // share. Each sees every value the option takes; the rule must settle.
  it('two clients with different cells settle on the last to measure, with no write in answer to a write', () => {
    let option = '';
    const writes: string[] = [];
    const clients = {
      a: { own: '9x24', claimed: null as string | null },
      b: { own: '10x26', claimed: null as string | null },
    };
    const see = (name: 'a' | 'b') => {
      const client = clients[name];
      const { write, claimed } = cellSizeClaim(client.own, option, client.claimed);
      client.claimed = claimed;
      if (write) {
        writes.push(`${name}:${client.own}`);
        option = client.own;
      }
    };

    see('a');
    expect(option).toBe('9x24');
    // B connects later: its first look finds another cell, and takes over.
    see('b');
    expect(option).toBe('10x26');
    for (let round = 0; round < 5; round++) {
      see('a');
      see('b');
    }
    expect(writes).toEqual(['a:9x24', 'b:10x26']);

    // A's font changes: it measured last, so it writes, and B lets it stand.
    clients.a.own = '10x22';
    see('a');
    see('b');
    see('a');
    expect(writes).toEqual(['a:9x24', 'b:10x26', 'a:10x22']);
    expect(option).toBe('10x22');
  });

  it('a client that finds its own cell announced writes nothing', () => {
    expect(cellSizeClaim('9x24', '9x24', null)).toEqual({ write: false, claimed: '9x24' });
    expect(cellSizeClaim('9x24', '', null)).toEqual({ write: true, claimed: '9x24' });
  });

  it('a pixel is scaled to the announced cell, and left alone with none or the same', () => {
    expect(scaleToAnnounced({ x: 15, y: 26 }, { width: 10, height: 26 }, '9x24')).toEqual({
      x: 13.5,
      y: 24,
    });
    for (const announced of ['', '10x26', 'junk']) {
      expect(scaleToAnnounced({ x: 15, y: 26 }, { width: 10, height: 26 }, announced)).toEqual({
        x: 15,
        y: 26,
      });
    }
    // Announced as formatted: 8.5333 is the 8.53 this client wrote.
    expect(scaleToAnnounced({ x: 853, y: 1 }, { width: 8.53333, height: 18 }, '8.53x18')).toEqual({
      x: 853,
      y: 1,
    });
  });
});
