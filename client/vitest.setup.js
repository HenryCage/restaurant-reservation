import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// RTL's auto-cleanup relies on detecting a global `afterEach` (Jest-style
// globals). This project deliberately keeps `globals: false` in
// vitest.config.js to match the backend's explicit-import style, so
// cleanup has to be wired up by hand instead.
afterEach(() => {
  cleanup();
});
