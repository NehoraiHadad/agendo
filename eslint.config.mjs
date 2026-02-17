import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  // Global ignores
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'dist/**',
    'node_modules/**',
    'next-env.d.ts',
    '*.config.*',
    'coverage/**',
  ]),

  // Next.js recommended rules (core web vitals + typescript)
  ...nextVitals,
  ...nextTs,

  // Base JS recommended rules
  {
    name: 'eslint/recommended',
    ...js.configs.recommended,
  },

  // TypeScript strict rules
  ...tseslint.configs.strict.map((config) => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx'],
  })),

  // React Hooks rules
  {
    name: 'react-hooks/recommended',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // React Refresh rules (for HMR)
  {
    name: 'react-refresh',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Project-specific overrides
  {
    name: 'project/overrides',
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // TypeScript strict - no any
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Prefer const assertions and type safety
      '@typescript-eslint/prefer-as-const': 'error',
      '@typescript-eslint/no-non-null-assertion': 'warn',
    },
  },

  // shadcn/ui components export variant helpers alongside components — this is expected
  {
    name: 'project/shadcn-overrides',
    files: ['src/components/ui/**/*.tsx', 'src/app/layout.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },

  // Relax rules for test files
  {
    name: 'project/test-overrides',
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
]);

export default eslintConfig;
