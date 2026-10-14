import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent worktrees under .claude/ are full repository copies; never collect them.
    exclude: [...configDefaults.exclude, '.claude/**', 'tests/stale/**'],
    // The accessibility tests run axe over a full page in jsdom; under a loaded machine or a
    // shared CI runner they exceed vitest's 5 s default without anything being wrong.
    testTimeout: 20_000,
    setupFiles: ['./tests/setup/pin-clock.ts'],
  },
});
