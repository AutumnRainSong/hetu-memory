import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    server: { deps: { external: [/node:sqlite/] } },
  },
});
