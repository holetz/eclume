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
  },
  "settings": {
    "title": "Configurações",
    "back": "Voltar",
    "tabs": {
      "general": "Geral",
      "meetings": "Reuniões",
      "audio": "Áudio",
      "storage": "Armazenamento",
      "folder": "Pasta",
      "server": "Servidor"
    },
    "appearance": "Aparência",
    "theme": "Tema",
    "themeHint": "Claro, escuro ou como o sistema",
    "themeSystem": "Sistema",
    "themeLight": "Claro",
    "themeDark": "Escuro",
    "recentWindow": "Gravações recentes na janela",
    "recentWindowHint": "Estado, alertas e Copiar resumo no topo da janela principal",
    "hide": "Ocultar",
    "recentTray": "Gravações recentes no menu da bandeja",
    "recentTrayHint": "Título, estado e ações no menu do ícone ao lado do relógio",
    "startup": "Início",
    "startWithSystem": "Iniciar com o computador",
    "startupHint": "O eclume abre sozinho, só na bandeja, quando você entra no computador, para não perder uma reunião.",
    "notifications": "Avisos",
    "notifySummary": "Avisar quando uma gravação terminar de processar",
    "notificationsHint": "De todas as gravações da conta: resumo pronto (com \"Copiar\"), pronta sem resumo ou com falha.",
    "detect": "Detectar reuniões",
    "detectHint": "O eclume observa qual app usa o microfone. Nunca grava sem mostrar na bandeja.",
    "meetingStarts": "Quando uma reunião começa no",
    "restoreDefaults": "Restaurar padrões",
    "meetingStopHint": "Gravar para sozinho quando a reunião acaba. Uma gravação que você inicia segue até você parar.",
    "sources": "Fontes",
    "microphone": "Microfone",
    "systemAudio": "Áudio do sistema",
    "sourcesHint": "Capta as outras pessoas da chamada pelos alto-falantes ou pelo fone. As duas fontes viram um arquivo só; \"Nenhum\" deixa uma delas de fora.",
    "test": {
      "mic": "Fale para testar",
      "system": "Toque algo para testar"
    },
    "transcription": "Transcrição",
    "transcriptionLanguage": "Idioma da transcrição",
    "accountDefault": "Padrão da conta",
    "languages": {
      "auto": "Detectar automaticamente",
      "pt": "Português",
      "es": "Español",
      "en": "English"
    },
    "transcriptionHint": "Vale para as próximas reuniões e notas enviadas. O padrão da conta se escolhe na web, em Conta.",
    "shortcutsTitle": "Atalhos em qualquer lugar do computador",
    "voiceNotes": "Notas de voz",
    "silence": "Parar depois de silêncio",
    "silenceHint": "Encerra a nota quando você para de falar",
    "never": "Nunca",
    "retentionTitle": "Depois que o servidor confirma uma gravação",
    "deleteLocal": "Apagar a cópia local",
    "deleteLocalHint": "Libera espaço na hora",
    "keepDays": "Manter por alguns dias",
    "keepDaysHint": "Padrão · até 3650 dias",
    "daysLabel": "Dias",
    "days": "dias",
    "keepForever": "Manter para sempre",
    "keepForeverHint": "Nada é apagado deste computador",
    "retentionHint": "Gravações ainda não enviadas nunca são apagadas.",
    "localFolder": "Pasta local",
    "showFolder": "Mostrar",
    "retry": "Tentar de novo as falhas",
    "folderEnable": "Sincronizar resumos numa pasta",
    "folderHint": "O resumo de cada gravação vira um arquivo Markdown e a transcrição, um arquivo JSONL, numa pasta deste computador. Vale para toda a sua biblioteca, não só para o que este computador gravou.",
    "folderDestination": "Pasta de destino",
    "noneFemale": "Nenhuma",
    "folderChoose": "Escolher pasta…",
    "folderTranscripts": "Incluir as transcrições (.jsonl)",
    "folder": {
      "off": "Desligada",
      "choose": "Escolha a pasta para começar",
      "syncing": "Sincronizando…",
      "waiting": "Aguardando o primeiro ciclo",
      "synced": "Sincronizada às {time} · {loaded} no último ciclo",
      "recordings": {
        "one": "1 gravação lida",
        "other": "{count} gravações lidas"
      }
    },
    "folderNow": "Sincronizar agora",
    "folderLayout": "Como a pasta é organizada",
    "folderRules": {
      "collectionsTitle": "Coleções viram subpastas, e cada uma se divide por mês.",
      "example": "Ex.:",
      "examplePath": "Clientes/2026-09/",
      "collectionsBody": ". Uma gravação em mais de uma coleção aparece em cada uma; as sem coleção ficam em",
      "uncollected": "sem-colecao",
      "collectionsEnd": ". Organize as coleções no eclume web.",
      "nameTitle": "Nome que ordena por data.",
      "nameBody": ": data, hora e a referência da gravação (a mesma \"ref.\" do eclume web). O título fica dentro do arquivo, não no nome.",
      "filesTitle": "Resumo e transcrição lado a lado.",
      "summaryPrefix": "O resumo é um",
      "transcriptPrefix": "com propriedades no topo; a transcrição é um",
      "filesEnd": "com o mesmo nome.",
      "obsidianTitle": "Vault do Obsidian.",
      "obsidianPrefix": "Abra a pasta como vault: o Obsidian lê os",
      "obsidianMiddle": "e ignora os",
      "obsidianEnd": ", então as transcrições não poluem a busca nem o grafo.",
      "agentTitle": "Pasta de trabalho de agente.",
      "agentPrefix": "O app mantém um",
      "agentEnd": "na raiz que explica a um agente (como o Claude Code) como ler e pesquisar os arquivos.",
      "mirrorTitle": "É um espelho.",
      "mirrorBody": "O eclume sobrescreve os arquivos que gerou; edite uma cópia. Arquivos seus na pasta nunca são tocados."
    },
    "folderHelp": "Saiba mais na ajuda",
    "signIn": "Entrar com e-mail e senha",
    "signOut": "Sair",
    "serverAddress": "Endereço do servidor",
    "advanced": "Avançado",
    "advancedHint": "Para servidores com API separada ou certificado próprio",
    "apiAddress": "Endereço da API",
    "apiPlaceholder": "O mesmo do servidor",
    "extraCa": "Autoridade certificadora extra",
    "remove": "Remover",
    "choose": "Escolher…",
    "caHint": "Arquivo PEM. Só é preciso quando o servidor usa um certificado próprio.",
    "save": "Salvar",
    "testConnection": "Testar conexão",
    "locale": {
      "title": "Idioma",
      "automatic": "Automático (conta, depois sistema)",
      "en": "English",
      "ptBR": "Português (Brasil)"
    },
    "mode": {
      "portal": "Pelo portal de atalhos do sistema. Se ele pedir, confirme as combinações.",
      "system": "Nesta sessão (Wayland), crie no sistema um atalho para cada comando abaixo.",
      "created": "Nesta sessão (Wayland), os atalhos são do GNOME e chamam o eclume.",
      "create": "Nesta sessão (Wayland), o eclume não ouve o teclado sozinho: crie os atalhos no GNOME."
    },
    "connection": {
      "empty": "Conectado · nenhum envio ainda",
      "upload": "Conectado · último envio {time}"
    },
    "shortcutBackground": "Funciona com o eclume em segundo plano",
    "capture": "Pressione a combinação…",
    "cancel": "Cancelar",
    "change": "Alterar",
    "gnome": {
      "remove": "Remover atalhos do GNOME",
      "create": "Criar atalhos no GNOME",
      "creating": "Criando atalhos…",
      "removing": "Removendo atalhos…",
      "created": "Atalhos criados no GNOME.",
      "removed": "Atalhos removidos do GNOME."
    },
    "modifierRequired": "Use Ctrl, Alt, Shift ou ⌘ junto da tecla.",
    "systemDefault": "Padrão do sistema",
    "none": "Nenhum",
    "followOutput": "Seguir a saída em uso",
    "stop": "Parar",
    "account": {
      "personal": "Conectado com um token pessoal",
      "empty": "Nenhuma conta neste computador",
      "replaceToken": "Entre com e-mail e senha para trocar o token pela conta",
      "signInHint": "Entre para enviar as gravações",
      "connected": "Conectado ao {server}"
    },
    "invalidDays": "Use de 1 a 3650 dias.",
    "retrySuccess": "As falhas vão ser enviadas de novo.",
    "serverSaved": "Configurações do servidor salvas.",
    "testing": "Testando…",
    "apps": {
      "teams": {
        "title": "Microsoft Teams",
        "subtitle": "App ou aba do navegador"
      },
      "zoom": {
        "title": "Zoom",
        "subtitle": "App ou aba do navegador"
      },
      "meet": {
        "title": "Google Meet",
        "subtitle": "Aba do navegador"
      },
      "webex": {
        "title": "Webex",
        "subtitle": "App ou aba do navegador"
      },
      "slack": {
        "title": "Slack",
        "subtitle": "Chamadas"
      },
      "whatsapp": {
        "title": "WhatsApp",
        "subtitle": "App ou aba do WhatsApp Web"
      },
      "navegador": {
        "title": "Navegador",
        "subtitle": "Microfone em uso, reunião não reconhecida"
      },
      "outro": {
        "title": "Outro app",
        "subtitle": "Ditado, gravadores de voz, jogos"
      }
    },
    "policy": {
      "auto": "Gravar",
      "ask": "Confirmar",
      "ignore": "Ignorar"
    },
    "accountDefaultNamed": "Padrão da conta: {name}",
    "systemDefaultNamed": "Padrão do sistema · {name}",
    "disconnectedMic": "{name} (desconectado)",
    "disconnectedOutput": "{name} (desconectada)",
    "shortcut": {
      "record": "Iniciar ou parar a gravação",
      "note": "Nova nota",
      "marker": "Adicionar marcador"
    },
    "registration": {
      "in_use": "Em uso por outro app",
      "unavailable": "Indisponível nesta sessão",
      "system": "Crie o atalho no sistema"
    },
    "storageUsed": {
      "one": "1 gravação · {size} neste computador",
      "other": "{count} gravações · {size} neste computador"
    }
  }
};
