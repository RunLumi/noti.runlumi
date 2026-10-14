import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent worktrees under .claude/ are full repository copies; never collect them.
    exclude: [...configDefaults.exclude, '.claude/**', 'tests/stale/**'],
    // The accessibility tests run axe over a full page in jsdom; under a loaded machine or a
    // shared CI runner they exceed vitest's 5 s default without anything being wrong.
    testTimeout: 20_000,
    setupFiles: ['./tests/setup/pin-clock.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.{ts,tsx}', 'web/src/**/*.{ts,tsx}'],
      exclude: ['web/src/routeTree.gen.ts', '**/*.d.ts'],
      // A floor, not a target (spec 01 F02): set a little under the measured figure, and it may only go up.
      // Lowering a number here is a deliberate, reviewed change; see docs/adr/0027-platform-gates.md.
      thresholds: { statements: 89, branches: 84, functions: 85, lines: 91 },
    },
  },
});
