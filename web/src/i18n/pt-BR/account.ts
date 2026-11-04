import type en from '../en/account'
import type { Catalog } from '../locale'

const account: Catalog<typeof en> = {
  locale: {
    title: 'Idioma',
    label: 'Idioma da interface',
    browser: 'Idioma do navegador',
    hint: 'O idioma das telas, das mensagens e do que os agentes escrevem daqui em diante. Não muda o idioma da transcrição.',
    saved: 'Idioma salvo.',
  },
}

export default account
