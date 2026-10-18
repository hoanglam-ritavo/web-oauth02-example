import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default defineConfig(
  { ignores: ['dist/**', 'node_modules/**'] },
  { files: ['**/*.{js,mjs,ts}'], extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
