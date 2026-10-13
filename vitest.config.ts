import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent worktrees under .claude/ are full repository copies; never collect them.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
