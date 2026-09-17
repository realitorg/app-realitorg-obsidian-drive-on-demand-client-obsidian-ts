// The Obsidian community directory reviews plugins with these rules: running them here
// catches what the review would report before a release.
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  { ignores: ['main.js', 'node_modules/**'] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mjs'],
        },
      },
    },
  },
  {
    // Build and test tooling runs in Node, never in the plugin shipped to users.
    files: ['esbuild.config.mjs', 'vitest.config.ts'],
    languageOptions: { globals: { process: 'readonly' } },
    rules: { 'obsidianmd/no-nodejs-modules': 'off' },
  },
]);
