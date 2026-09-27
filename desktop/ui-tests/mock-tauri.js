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
    };
  }

  const cenarios = {
    ocioso() {},
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
