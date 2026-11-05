import type en from '../en/import'
import type { Catalog } from '../locale'

const importCatalog: Catalog<typeof en> = {
  source: {
    metadata: 'Dos metadados do arquivo',
    metadata_day: 'Só o dia nos metadados · a hora é a da modificação, confira',
    file_date: 'Sem data no arquivo · usando a data de modificação, confira',
    user: 'Editada por você',
  },
  announced: {
    converting: 'convertendo',
    uploading: 'enviando',
    done: 'enviado',
    error: 'falhou',
    canceled: 'cancelado',
  },
  announce: '{{name}}: {{state}}',
  notify: {
    blocked: ' · O navegador bloqueou os avisos deste site',
    offer: 'Avisar quando ficar pronta',
  },
  status: {
    reading: 'Lendo…',
    ready: 'Pronto para enviar',
    converting: 'Convertendo {{percent}}%',
    uploadingPart: 'Enviando {{current}} de {{total}}',
    uploading: 'Enviando…',
    duplicate: 'Já estava na biblioteca',
    done: 'Enviado',
    open: 'Abrir',
    error: '{{state}}: {{message}}',
    canceled: 'Cancelado',
  },
  row: {
    start: 'Início da gravação de {{name}}',
    readingDate: 'Lendo a data do arquivo…',
    language: 'Idioma de {{name}}',
    cancel: 'Cancelar o envio de {{name}}',
    remove: 'Remover {{name}}',
  },
  dialog: {
    accountDefault: 'Padrão da conta',
    title: 'Importar arquivos',
    kicker: 'Biblioteca',
    close: 'Fechar',
    sendNone: 'Enviar arquivos',
    send_one: 'Enviar 1 arquivo',
    send_other: 'Enviar {{count}} arquivos',
    insecure: 'A conversão exige uma conexão segura. Abra o eclume pelo endereço <b>https://</b> e instale o certificado, se o navegador pedir.',
    noWebCodecs: 'Este navegador não tem WebCodecs. A conversão usa o modo compatível, mais lento; prefira um Chrome, Edge ou Firefox atualizado.',
    drop: 'Solte áudio ou vídeo aqui',
    choose: 'ou <choose>escolha arquivos</choose> · MP3, M4A, WAV, OGG, MP4, MOV, WebM, MKV e outros',
  },
  table: {
    file: 'Arquivo',
    start: 'Início da gravação',
    language: 'Idioma',
    duration: 'Duração',
    status: 'Situação',
    actions: 'Ações',
  },
}

export default importCatalog
