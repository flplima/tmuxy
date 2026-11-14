import { describe, expect, it } from 'vitest';
import words from '../../../../tmuxy-cli/bin/tmuxy/session-names.json';
import { memorableSessionName, sessionNameFrom } from '../sessionNames';

const PAIRS = words.adjectives.flatMap((adjective) =>
  words.nouns.map((noun) => `${adjective}-${noun}`),
);

describe('memorableSessionName', () => {
  it('is an adjective and a noun from the shared lists, a name tmux accepts', () => {
    for (const random of [0, 0.25, 0.5, 0.999999]) {
      const name = memorableSessionName([], () => random);
      expect(PAIRS).toContain(name);
      expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    }
  });

  it('starts from the pair the random draw lands on', () => {
    expect(memorableSessionName([], () => 0)).toBe(PAIRS[0]);
    expect(memorableSessionName([], () => 0.5)).toBe(PAIRS[PAIRS.length / 2]);
  });

  it('never takes a name a session already has', () => {
    expect(memorableSessionName([PAIRS[0], PAIRS[1]], () => 0)).toBe(PAIRS[2]);
    const free = PAIRS[0];
    expect(memorableSessionName(PAIRS.slice(1), () => 0.7)).toBe(free);
  });

  it('adds a number only once every pair is taken', () => {
    const taken = [...PAIRS, `${PAIRS[0]}-2`];
    expect(memorableSessionName(taken, () => 0)).toBe(`${PAIRS[0]}-3`);
  });

  it('keeps the lists small, unique and plain', () => {
    for (const list of [words.adjectives, words.nouns]) {
      expect(new Set(list).size).toBe(list.length);
      for (const word of list) expect(word).toMatch(/^[a-z]+$/);
    }
  });
});

describe('sessionNameFrom', () => {
  it('keeps a name the server takes as typed', () => {
    expect(sessionNameFrom('work')).toBe('work');
    expect(sessionNameFrom('  api_v2+test@home  ')).toBe('api_v2+test@home');
  });

  it('turns what the server refuses into dashes, and never starts with one', () => {
    expect(sessionNameFrom('my project')).toBe('my-project');
    expect(sessionNameFrom('a.b:c')).toBe('a-b-c');
    expect(sessionNameFrom('--flag')).toBe('flag');
    expect(sessionNameFrom("x'; kill-server #")).toBe('x-kill-server');
  });

  it('makes no name of nothing', () => {
    expect(sessionNameFrom('')).toBeNull();
    expect(sessionNameFrom(' . : ')).toBeNull();
  });
});
