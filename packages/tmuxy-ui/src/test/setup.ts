import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

// Node ≥ 22 defines an experimental `localStorage` getter on globalThis that
// yields undefined unless --localstorage-file is set; jsdom's Storage is then
// never installed because the key already exists. Provide a Storage-shaped
// in-memory stand-in so the code under test sees a working localStorage.
if (typeof localStorage === 'undefined') {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return store.size;
    },
    key: (index) => [...store.keys()][index] ?? null,
    getItem: (key) => store.get(String(key)) ?? null,
    setItem: (key, value) => void store.set(String(key), String(value)),
    removeItem: (key) => void store.delete(String(key)),
    clear: () => store.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true });
}

afterEach(() => {
  cleanup();
  // localStorage persists across tests in the same file; clear it so state
  // read at mount (e.g. createInitialContext → loadThemeFromStorage) doesn't
  // leak a previous test's writes into the next one.
  localStorage.clear();
});
