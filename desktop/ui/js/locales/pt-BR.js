// Both locale files must carry the same keys.
export default {
  "common": {
    "close": "Fechar",
    "cancel": "Cancelar",
    "save": "Salvar",
    "automatic": "Automático"
  },
  "vocabulary": {
    "step": {
      "received": "Áudio recebido",
      "preprocessing": "Pré-processamento",
      "transcription": "Transcrição",
      "speakers": "Locutores",
      "agenda_type": "Tipo de agenda",
      "fields": "Campos",
      "summary": "Resumo"
    },
    "busy": {
      "received": "Enviando",
      "preprocessing": "Pré-processando",
      "transcription": "Transcrevendo",
      "speakers": "Conferindo locutores",
      "agenda_type": "Detectando o tipo",
      "fields": "Preenchendo campos",
      "summary": "Resumindo"
    },
    "stepState": {
      "pending": "esperando",
      "active": "em andamento",
      "done": "concluída",
      "skipped": "pulada",
      "failed": "falhou",
      "waiting": "aguardando você"
    },
    "reason": {
      "no_provider": "nenhum agente configurado; fale com quem administra",
      "no_auto_fields": "nenhum campo com preenchimento automático",
      "no_types": "só o tipo padrão está cadastrado: ficou ele",
      "set_by_user": "o tipo foi escolhido por você",
      "no_agenda_type": "a gravação não tem tipo de agenda",
      "before_pipeline": "gravação anterior ao processamento automático",
      "worker_without_preprocess": "o processador desta gravação não faz pré-processamento",
      "summary_deleted": "o resumo foi excluído",
      "cancelled": "a transcrição foi cancelada",
      "unnamed_speakers": "há locutores sem pessoa; nomeie todos para seguir com o tipo, os campos e o resumo",
      "continued_by_user": "você seguiu sem nomear todos os locutores",
      "naming_not_required": "a conta deixou de exigir os nomes dos locutores"
    },
    "device": {
      "recording": "Gravando",
      "pending": "Aguardando envio",
      "uploading": "Enviando",
      "uploaded": "Enviada",
      "interrupted": "Interrompida",
      "failed": "Falhou o envio"
    },
    "queue": {
      "offline": "O processador está fora do ar; sua gravação está guardada e entra quando ele voltar.",
      "offlineSince": "O processador está fora do ar desde {time}; sua gravação está guardada e entra quando ele voltar.",
      "accountNext": "Na vez da sua conta: é a próxima gravação sua a entrar na fila.",
      "quotaAt": "Seus minutos de transcrição das últimas 24 h acabaram; a gravação entra às {time}.",
      "quotaLater": "Seus minutos de transcrição das últimas 24 h acabaram; a gravação entra quando a janela liberar.",
      "position": "{position}ª na fila",
      "starts": "começa em {eta} (estimativa)",
      "waiting": "Aguardando a vez na fila de transcrição.",
      "dayTime": "{date} às {time}",
      "lessThanMinute": "menos de 1 min",
      "minutes": "cerca de {minutes} min",
      "hours": "cerca de {hours} h",
      "hoursMinutes": "cerca de {hours} h {minutes} min",
      "accountAhead": {
        "one": "Atrás de 1 gravação sua que chegou antes.",
        "other": "Atrás de {count} gravações suas que chegaram antes."
      }
    },
    "server": {
      "na_fila": "Na fila",
      "em_andamento": "Em andamento",
      "aguardando_locutores": "Aguardando locutores",
      "pronta": "Pronta",
      "falhou": "Falhou",
      "cancelada": "Cancelada"
    }
  },
  "help": {
    "title": "Ajuda",
    "firstSteps": "Primeiros passos",
    "permissions": "Permissões de microfone",
    "folder": "Pasta sincronizada",
    "shortcuts": "Atalhos de teclado",
    "center": "Abrir a central de ajuda",
    "problem": "Relatar um problema…",
    "attachLog": "Anexe o eclume.log",
    "close": "Fechar",
    "global": "Em qualquer lugar do computador",
    "window": "Nesta janela",
    "change": "Mudar os atalhos nas configurações",
    "import": "Importar arquivo",
    "settings": "Configurações",
    "version": "eclume {version} · atualizado",
    "shortcut": {
      "record": "Iniciar ou parar a gravação",
      "note": "Nova nota",
      "marker": "Adicionar marcador"
    }
  },
  "home": {
    "settings": "Configurações",
    "loading": "Carregando…",
    "startRecording": "Iniciar gravação",
    "automatic": "Iniciada automaticamente. Para quando a reunião acabar.",
    "import": "Importar arquivo…",
    "policySettings": "Mudar nas configurações",
    "policy": {
      "record": "Gravar",
      "ask": "Confirmar",
      "ignore": "Ignorar"
    },
    "meetingDetected": "Reunião detectada",
    "notNow": "Agora não",
    "uploadQueue": "Fila de envio",
    "today": "Hoje, {time}",
    "yesterday": "Ontem, {time}",
    "recording": "Gravando{origin}{elapsed}",
    "meeting": "Reunião no {app}",
    "updated": "Atualizado para {version}",
    "policyTitle": "Reuniões no {app}",
    "prompt": "{app} está usando o microfone. Gravar?",
    "detecting": "Ocioso, atento a reuniões",
    "allUploaded": "Tudo enviado",
    "interrupted": "interrompida",
    "gotIt": "Entendi",
    "error": "Não deu certo",
    "notice": "Aviso",
    "upload": "Envio",
    "stopRecording": "Parar gravação",
    "tokenAccount": "Conectado com um token pessoal",
    "signOut": "Sair",
    "server": "Servidor",
    "uploading": {
      "one": "Enviando 1 gravação",
      "other": "Enviando {count} gravações"
    },
    "idleQueue": {
      "one": "Ocioso · 1 gravação na fila",
      "other": "Ocioso · {count} gravações na fila"
    },
    "queueSummary": {
      "one": "{uploaded} de {count} enviadas",
      "other": "{uploaded} de {count} enviadas"
    }
  },
  "recent": {
    "label": "Gravações recentes",
    "title": "Recentes",
    "empty": "Nenhuma gravação ainda.",
    "summaryReady": "Resumo pronto",
    "noSummary": "Pronta sem resumo",
    "summaryFailed": "O resumo falhou",
    "transcriptionFailed": "A transcrição falhou",
    "needsYou": "Precisa de você",
    "uploadFailed": "O envio falhou; o app tenta de novo sozinho.",
    "retrySummary": "Abra no web para gerar o resumo de novo.",
    "seeReason": "Abra no web para ver o motivo.",
    "transientFailure": "Falha passageira; o servidor tenta de novo.",
    "recording": "Gravação",
    "summaryCopied": "Resumo copiado em Markdown.",
    "copied": "Copiado",
    "copySummary": "Copiar resumo",
    "uploading": "Enviando…",
    "tryNow": "Tentar agora",
    "openWeb": "Abrir no web",
    "noResponse": "Sem resposta do servidor; tentando de novo.",
    "alertCount": {
      "one": "1 precisa de você",
      "other": "{count} precisam de você"
    },
    "resolveWeb": "{stage}{state}{reason} · resolva no web.",
    "progress": "Transcrição {percent}%"
  },
  "note": {
    "marker": "Marcador",
    "placeholder": "Nota curta (opcional)",
    "new": "Nova nota",
    "stopAfter": " · para depois de {seconds} s de silêncio",
    "recording": "Gravando uma nota{stop}",
    "silence": "Silêncio · para em {seconds} s",
    "stop": "Parar nota · {time}",
    "markerLabel": "Nota do marcador em {time}",
    "label": "Nota",
    "markerCount": {
      "one": "1 marcador",
      "other": "{count} marcadores"
    }
  },
  "firstRun": {
    "title": "Bem-vindo",
    "back": "Voltar",
    "searching": "Procurando o servidor na rede…",
    "server": "Servidor",
    "trustTitle": "Confira com quem administra o servidor",
    "fingerprintPrefix": "A impressão digital do certificado de ",
    "fingerprintSuffix": " é:",
    "trustContinue": "Confiar e continuar",
    "email": "E-mail",
    "password": "Senha",
    "signIn": "Entrar",
    "noAccount": "Sem conta?",
    "signUp": "Crie uma na web",
    "advanced": "Avançado",
    "advancedHint": "Entrar com um código ou digitar o endereço",
    "pairingCode": "Código de pareamento",
    "pairingPlaceholder": "K7Q-4MX",
    "pair": "Entrar com o código",
    "pairingHint": "Gere o código na web, em Minhas configurações › App desktop. Vale por 10 minutos.",
    "address": "Endereço do servidor",
    "addressPlaceholder": "servidor.local:8443",
    "useAddress": "Usar este endereço",
    "searchAgain": "Procurar na rede de novo",
    "serverLabel": "{name} em {host}",
    "origins": {
      "installer": "Veio com este instalador",
      "network": "Encontrado na rede",
      "typed": "Endereço digitado"
    },
    "useAnother": "Usar outro",
    "noServers": "Nenhum servidor na rede. Digite o endereço em Avançado.",
    "missingCode": "Digite o código de 6 caracteres mostrado na web.",
    "invalidAddress": "Endereço inválido: digite o host do servidor, com ou sem https.",
    "chooseServer": "Escolha o servidor antes de criar a conta."
  },
  "import": {
    "title": "Importar um arquivo",
    "close": "Fechar",
    "drop": "Solte o áudio ou o vídeo aqui",
    "or": "ou",
    "choose": "escolha um arquivo",
    "converting": "Convertendo para Opus…",
    "confirm": "Pôr na fila de envio",
    "cancel": "Cancelar",
    "errorTitle": "Não deu para importar",
    "dateOrigin": {
      "fileMtime": "Gravado em · data de modificação do arquivo; confira.",
      "metadata": "Gravado em · lida do arquivo. Mude se estiver errada."
    },
    "noAudio": "{name} não tem áudio."
  }
};
