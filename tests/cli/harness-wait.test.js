/**
 * `waitFor` (`helpers/wait.js`), which every wait of this suite goes through:
 * a wait that gives up has to say what it was waiting for and what it saw.
 */

const { waitFor } = require('./helpers/wait');

describe('waitFor', () => {
  test('keeps looking through "not yet" and resolves with what it found', async () => {
    let looks = 0;
    await expect(waitFor('a third look', () => ++looks === 3 && 'found')).resolves.toBe('found');
  });

  test('past its deadline it names what it waited for and what it saw', async () => {
    await expect(
      waitFor('two lines', () => false, { saw: () => '["one"]', timeoutMs: 0 }),
    ).rejects.toThrow('waited for two lines: not after 0ms; saw ["one"]');
  });

  test('it gives up at once when what it waits for can no longer come', async () => {
    await expect(waitFor('another line', () => false, { over: () => true })).rejects.toThrow(
      'waited for another line: it can no longer come',
    );
  });
});
