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
      // Estilo por classe (app.css): `style` só leva custom property (`--h` do medidor), como o
      // ui_assets do desktop exige da UI estática.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXAttribute[name.name='style'] ObjectExpression > Property:not([key.type='Literal'][key.value=/^--/]):not([computed=true])",
          message: 'Sem `style` fixo: use uma classe do app.css; `style` só com custom property (--nome).',
        },
      ],
    },
  },
])
