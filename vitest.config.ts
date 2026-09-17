import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Un vrai `window` (minuteries window.*), comme dans Obsidian.
    environment: 'happy-dom',
  },
  resolve: {
    // Le module 'obsidian' n'a pas d'entrée résolvable hors runtime Obsidian ;
    // on l'aliase vers un stub minimal pour pouvoir tester la couche vault-ops.
    alias: {
      obsidian: fileURLToPath(new URL('./src/test-support/obsidian-stub.ts', import.meta.url)),
    },
  },
});
