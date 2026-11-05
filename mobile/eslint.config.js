import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores(['dist', 'coverage', 'src-tauri', 'plugins', 'crates', 'target', 'e2e']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    rules: {
      // Style by class (app.css): `style` carries only a custom property (the meter's `--h`), as the
      // desktop's ui_assets requires of the static UI.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXAttribute[name.name='style'] ObjectExpression > Property:not([key.type='Literal'][key.value=/^--/]):not([computed=true])",
          message: 'No fixed `style`: use an app.css class; `style` only with a custom property (--name).',
        },
      ],
    },
  },
])
