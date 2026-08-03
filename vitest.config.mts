import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The socket suite starts a real server on an ephemeral port, so the
    // default parallel workers would race each other over shared module state.
    fileParallelism: false,
  },
});
