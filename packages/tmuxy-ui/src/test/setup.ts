import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

afterEach(() => {
  cleanup();
  // jsdom localStorage persists across tests in the same file; clear it so
  // state read at mount (e.g. createInitialContext → loadThemeFromStorage)
  // doesn't leak a previous test's writes into the next one.
  localStorage.clear();
});
