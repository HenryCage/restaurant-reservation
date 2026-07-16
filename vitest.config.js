import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Scoped to the backend's own test/ dir -- client/ is a separate npm
    // project with its own vitest.config.js and jsdom environment; without
    // this, vitest's default discovery glob picks up client/src/*.test.jsx
    // too and runs them in the wrong (non-DOM) environment.
    include: ['test/**/*.test.js'],
  },
});
