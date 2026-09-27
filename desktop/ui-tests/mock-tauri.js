// Tauri simulado para os testes de navegador da UI do desktop. Define `window.__TAURI__` (o que o
// `withGlobalTauri` expõe) com `core.invoke` e `event.listen`, e `window.__mock` para os testes:
// `cenario(nome)` troca o estado, `emitir(evento, payload)` dispara um evento do Rust e
// `chamadas` registra cada comando recebido. O cenário inicial vem de `window.__MOCK_CENARIO`.
(() => {
  const agora = Date.now();
  const MIN = 60_000;
  const hoje = (h, m) => {
    const d = new Date(agora);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };

  function gravacao(id, extra) {
    return {
      id,
      path: `/dados/gravacoes/${id}.ogg`,
      started_at: hoje(9, 0),
      ended_at: null,
      duration_ms: 54 * MIN,
      bytes: 750_000,
      status: "synced",
      interrupted: false,
      attempts: 1,
      last_error: null,
      remote_id: `srv-${id}`,
      upload_id: null,
      sha256: null,
      next_attempt_at: null,
      synced_at: agora,
      purged_at: null,
      meeting_app: null,
      ...extra,
    };
  }

  function base() {
    return {
      status: {
        status: "idle",
        recording_id: null,
        recording_started_at: null,
        recording_auto: false,
        recording_app: null,
        meeting: null,
        pending_ask: null,
        counts: { recording: 0, pending: 0, syncing: 0, synced: 3, failed: 0 },
        web_url: "https://192.168.15.199:8443",
        notice: null,
        sync_notice: null,
      },
      recordings: [
        gravacao("a", { started_at: hoje(9, 0), duration_ms: 54 * MIN }),
        gravacao("b", { started_at: hoje(8, 18), duration_ms: 1 * MIN }),
        gravacao("c", { started_at: hoje(8, 18) - 24 * 60 * MIN + 8 * 60 * MIN, duration_ms: 22 * MIN }),
      ],
      settings: {
        web_url: "https://192.168.15.199:8443",
        api_url: null,
        ca_path: null,
        detection_enabled: true,
        apps: [
          ["teams", "Microsoft Teams", "ask"],
          ["zoom", "Zoom", "ask"],
          ["meet", "Google Meet", "ask"],
          ["webex", "Webex", "ask"],
          ["slack", "Slack", "ask"],
          ["navegador", "navegador", "ask"],
          ["outro", "outro app", "ignore"],
        ].map(([app, label, policy]) => ({ app, label, policy })),
        retention_days: 7,
        pat_source: "keyring",
      },
      versao: "0.2.0",
    };
  }

  const cenarios = {
    ocioso() {},
    gravando(e) {
      Object.assign(e.status, {
        status: "recording",
        recording_id: "r1",
        recording_started_at: agora - (12 * MIN + 4_000),
        recording_auto: true,
        recording_app: { app: "teams", label: "Microsoft Teams" },
        meeting: { app: "teams", label: "Microsoft Teams" },
      });
      e.recordings.unshift(gravacao("r1", { status: "recording", started_at: agora - 12 * MIN, duration_ms: null }));
    },
    pergunta(e) {
      e.status.meeting = { app: "zoom", label: "Zoom" };
      e.status.pending_ask = { app: "zoom", label: "Zoom" };
    },
    fila(e) {
      e.status.counts = { recording: 0, pending: 1, syncing: 1, synced: 1, failed: 1 };
      e.recordings = [
        gravacao("s", { status: "syncing", started_at: hoje(9, 0) }),
        gravacao("n", { status: "synced", started_at: hoje(8, 18), duration_ms: 1 * MIN, kind: "note" }),
        gravacao("f", { status: "failed", last_error: "HTTP 413: arquivo grande demais" }),
        gravacao("i", { status: "pending", original_name: "kickoff-guion", duration_ms: 47 * MIN }),
      ];
    },
    vazio(e) {
      e.recordings = [];
      e.status.counts = { recording: 0, pending: 0, syncing: 0, synced: 0, failed: 0 };
      e.settings.pat_source = null;
      e.settings.detection_enabled = false;
      e.status.sync_notice = "Sem PAT: as gravações ficam na fila até você configurar o PAT nas configurações.";
    },
  };

  const ouvintes = new Map();
  const mock = {
    estado: base(),
    chamadas: [],
    cenario(nome) {
      const aplicar = cenarios[nome];
      if (!aplicar) throw new Error(`cenário desconhecido: ${nome}`);
      mock.estado = base();
      aplicar(mock.estado);
      mock.emitir("status-changed");
    },
    emitir(evento, payload) {
      for (const handler of ouvintes.get(evento) ?? []) handler({ event: evento, payload });
    },
  };

  const comandos = {
    status: (e) => e.status,
    recordings: (e) => e.recordings,
    settings: (e) => e.settings,
    open_web: () => null,
    answer_meeting(e) {
      e.status.pending_ask = null;
      return null;
    },
    toggle_recording(e) {
      if (e.status.status === "recording") {
        Object.assign(e.status, { status: "idle", recording_id: null, recording_started_at: null, recording_auto: false, recording_app: null });
      } else {
        Object.assign(e.status, { status: "recording", recording_id: "novo", recording_started_at: Date.now() });
      }
      return e.status;
    },
    new_note() {
      throw "Já há uma gravação em andamento";
    },
  };

  window.__mock = mock;
  window.__TAURI__ = {
    core: {
      async invoke(comando, args) {
        mock.chamadas.push({ comando, args: args ?? null });
        const handler = comandos[comando];
        if (!handler) throw `comando sem mock: ${comando}`;
        return structuredClone(handler(mock.estado, args ?? {}));
      },
    },
    app: {
      async getVersion() {
        return mock.estado.versao;
      },
    },
    event: {
      async listen(evento, handler) {
        if (!ouvintes.has(evento)) ouvintes.set(evento, new Set());
        ouvintes.get(evento).add(handler);
        return () => ouvintes.get(evento).delete(handler);
      },
    },
  };

  const inicial = cenarios[window.__MOCK_CENARIO] ? window.__MOCK_CENARIO : "ocioso";
  cenarios[inicial](mock.estado);
})();
