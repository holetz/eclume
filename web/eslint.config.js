import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores(['dist', 'coverage']),
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
      // Estilo por classe (CSS Module ou app.css): `style` só leva custom property (--nome), como o
      // ui_assets do desktop exige da UI estática e o lint do celular.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXAttribute[name.name='style'] ObjectExpression > Property:not([key.type='Literal'][key.value=/^--/]):not([computed=true])",
          message: 'Sem `style` fixo: use uma classe; `style` só com custom property (--nome).',
        },
      ],
    },
  },
  {
    // O painel admin é um app à parte: nenhuma feature do usuário o importa (src/test/boundaries.test.ts
    // confere o mesmo, além dos ciclos entre features e de src/shared/).
    files: ['src/features/**/*.{ts,tsx}'],
    ignores: ['src/features/admin/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./(\\.\\./features/)?admin(/|$)',
              message: 'Feature do usuário não importa features/admin/ (o painel admin é um app à parte).',
            },
          ],
        },
      ],
    },
  },
  {
    // A biblioteca de conversão é autocontida: nada nela importa do app.
    files: ['src/lib/media-convert/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(\\.\\./|/)',
              message: 'src/lib/media-convert/ não importa de fora da própria pasta.',
            },
          ],
        },
      ],
    },
  },
])
