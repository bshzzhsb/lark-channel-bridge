import reactHooks from 'eslint-plugin-react-hooks';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'src/ui/generated/**',
      'web/dist/**',
      '.corepack/**',
      'scripts/**',
      'tests-smoke/**',
    ],
  },
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    // Keep existing suppressions for other rules while introducing import checks.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'unused-imports': unusedImports,
      'react-hooks': reactHooks,
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      'unused-imports/no-unused-imports': 'error',
      'simple-import-sort/imports': ['error', {
        groups: [
          ['^@?\\w'], // External packages.
          ['^node:'], // Node builtins.
          ['^@/'], // Project modules.
          ['^\\.'], // Relative paths within a module.
          ['^'], // Other paths.
          ['^\\u0000'], // Side effects; retain their relative order.
        ],
      }],
    },
  },
];
