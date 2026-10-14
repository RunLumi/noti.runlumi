import { defineConfig } from 'vitest/config';

// Date-driven checks that must not gate pull requests. See tests/stale/.
export default defineConfig({
  test: { include: ['tests/stale/**/*.stale.test.ts'] },
});
