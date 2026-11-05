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
  }
};
