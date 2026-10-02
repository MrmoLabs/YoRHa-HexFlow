import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // ignoreRestSiblings: 省略式解构 `(({ a, b, ...rest }) => rest)(obj)` 里的
      // a/b 是**故意**丢掉的，不算未用变量（ESLint 官方为这个惯单开的开关）。
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', ignoreRestSiblings: true }],
    },
  },
])
