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

  const CA = "98e209f5457514b7b12ec349d22b3b0d93c03c3f10e52350ea5f9e0b3d97792f";
  const CONTA = { email: "ana@exemplo.com.br", token_id: "t-1", server_name: "eclume" };

  function base() {
    return {
      status: {
        status: "idle",
        recording_id: null,
        recording_started_at: null,
        recording_kind: null,
        note_silence_s: 4,
        marker_count: 0,
        last_marker: null,
        recording_auto: false,
        recording_app: null,
        meeting: null,
        pending_ask: null,
        counts: { recording: 0, pending: 0, syncing: 0, synced: 3, failed: 0 },
        web_url: "https://192.168.15.199:8443",
        notice: null,
        sync_notice: null,
        updated: null,
        connection: "account",
        account: CONTA,
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
        ].map(([app, label, policy]) => ({ app, label, policy, default_policy: app === "outro" ? "ignore" : "ask" })),
        retention_days: 7,
        pat_source: "keyring",
        connection: "account",
        account: CONTA,
        shortcuts: [
          ["record", "Iniciar ou parar a gravação", "Ctrl+Alt+R"],
          ["note", "Nova nota", "Ctrl+Alt+N"],
          ["marker", "Adicionar marcador", "Ctrl+Alt+M"],
        ].map(([action, label, keys]) => ({ action, label, keys, registration: "registered", problem: null })),
        shortcut_mode: { mode: "global" },
        mic: null,
        system_source: "follow",
        note_silence_s: 4,
      },
      microfones: { default: "Microfone embutido", names: ["Microfone embutido", "Jabra Evolve2 65"] },
      saidas: {
        default: "alsa_output.pci-0000_00_1f.3.analog-stereo",
        devices: [
          { id: "alsa_output.pci-0000_00_1f.3.analog-stereo", name: "Alto-falantes embutidos" },
          { id: "bluez_output.jabra", name: "Jabra Evolve2 65" },
        ],
      },
      testeDeNivel: 0,
      marcadores: [],
      armazenamento: { dir: "/home/ana/.local/share/eclume/gravacoes", recordings: 3, bytes: 41_200_000 },
      importacao: {
        escolhido: "/home/ana/kickoff-guion.m4a",
        arquivos: {
          "/home/ana/kickoff-guion.m4a": {
            name: "kickoff-guion.m4a",
            duration_ms: 47 * MIN + 12_000,
            has_audio: true,
            decodable: true,
            recorded_at: new Date(2026, 8, 19, 14, 2).getTime(),
            date_origin: "mvhd",
          },
          "/home/ana/gravador.wav": {
            name: "gravador.wav",
            duration_ms: 90_000,
            has_audio: true,
            decodable: true,
            recorded_at: new Date(2026, 8, 20, 9, 30).getTime(),
            date_origin: "file_mtime",
          },
          "/home/ana/tela.mp4": {
            name: "tela.mp4",
            duration_ms: 60_000,
            has_audio: false,
            decodable: false,
            recorded_at: agora,
            date_origin: "file_mtime",
          },
        },
        pedido: null,
        falha: null,
        segurar: false,
        cancelada: false,
      },
      medidor: {
        position_ms: 42_000,
        levels: [0.3, 0.55, 0.8, 0.65, 0.9, 0.45, 0.7, 0.35, 0.2, 0.1, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05],
        stops_in_ms: 2_400,
      },
      versao: "0.2.0",
      servidores: [
        { name: "192.168.15.199", url: "https://192.168.15.199:8443", ca_sha256: CA, origin: "installer" },
        { name: "Escritório", url: "https://10.0.0.2", ca_sha256: CA, origin: "network" },
      ],
      preparado: null,
      testeDeConexao: { email: CONTA.email, last_upload_at: new Date(2026, 8, 27, 10, 38).getTime() },
    };
  }

  /** Sem credencial: a janela abre na primeira execução. */
  function semConta(e) {
    for (const alvo of [e.status, e.settings]) Object.assign(alvo, { connection: "first_run", account: null });
    e.settings.pat_source = null;
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
    nota(e) {
      Object.assign(e.status, {
        status: "recording",
        recording_id: "n1",
        recording_started_at: agora - 42_000,
        recording_kind: "note",
      });
      e.recordings.unshift(gravacao("n1", { status: "recording", kind: "note", started_at: agora - 42_000, duration_ms: null }));
    },
    marcadores(e) {
      cenarios.gravando(e);
      e.status.recording_auto = false;
      e.status.recording_app = null;
      e.marcadores = [
        { client_id: "m1", recording_id: "r1", at_ms: 125_000, note: "decisão do orçamento", created_at: agora - 60_000 },
      ];
      sincronizarMarcadores(e);
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
    atualizado(e) {
      e.status.updated = { version: "0.2.0", notes: "Nova nota, Importar arquivo e entrar com e-mail e senha" };
    },
    wayland(e) {
      e.settings.shortcut_mode = {
        mode: "system",
        gnome: true,
        commands: [
          ["record", "--alternar-gravacao"],
          ["note", "--nova-nota"],
          ["marker", "--marcador"],
        ].map(([action, flag]) => ({ action, command: `/usr/bin/eclume-desktop ${flag}` })),
      };
      for (const atalho of e.settings.shortcuts) {
        Object.assign(atalho, { registration: "system", problem: "Crie o atalho no sistema" });
      }
    },
    atalhoEmUso(e) {
      Object.assign(e.settings.shortcuts[1], { registration: "in_use", problem: "Em uso por outro app" });
      e.settings.mic = "Headset antigo";
    },
    vazio(e) {
      e.recordings = [];
      e.status.counts = { recording: 0, pending: 0, syncing: 0, synced: 0, failed: 0 };
      e.settings.detection_enabled = false;
      e.status.sync_notice = "Falha ao sincronizar: o servidor respondeu 503";
    },
    pat(e) {
      for (const alvo of [e.status, e.settings]) Object.assign(alvo, { connection: "personal_token", account: null });
    },
    primeiraExecucao: semConta,
    semServidor(e) {
      semConta(e);
      e.servidores = [];
    },
    caMudou(e) {
      semConta(e);
      e.status.sync_notice = "O certificado do servidor mudou";
    },
  };

  function sincronizarMarcadores(e) {
    e.status.marker_count = e.marcadores.length;
    e.status.last_marker = e.marcadores.at(-1) ?? null;
  }

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
    new_note(e) {
      if (e.status.recording_kind === "note") {
        Object.assign(e.status, { status: "idle", recording_id: null, recording_started_at: null, recording_kind: null });
      } else if (e.status.status === "recording") {
        throw "Já há uma gravação em andamento";
      } else {
        Object.assign(e.status, { status: "recording", recording_id: "nota", recording_started_at: Date.now(), recording_kind: "note" });
      }
      return null;
    },
    pick_import_file: (e) => e.importacao.escolhido,
    probe_import(e, { path }) {
      const lido = e.importacao.arquivos[path];
      if (!lido) throw `arquivo ilegível: ${path}`;
      return { path, ...lido };
    },
    import_file(e, args) {
      e.importacao.pedido = args;
      if (e.importacao.falha) {
        setTimeout(() => mock.emitir("import-failed", e.importacao.falha), 20);
        return null;
      }
      setTimeout(() => mock.emitir("import-progress", 0.5), 10);
      if (!e.importacao.segurar) setTimeout(() => mock.emitir("import-finished", "imp-1"), 30);
      return null;
    },
    cancel_import(e) {
      e.importacao.cancelada = true;
      return null;
    },
    note_meter: (e) => (e.status.recording_kind === "note" ? e.medidor : null),
    add_marker(e, { note }) {
      if (e.status.status !== "recording") throw "nenhuma gravação em andamento";
      const marcador = {
        client_id: `m${e.marcadores.length + 1}`,
        recording_id: e.status.recording_id,
        at_ms: 60_000 * (e.marcadores.length + 1),
        note: note ?? null,
        created_at: Date.now(),
      };
      e.marcadores.push(marcador);
      sincronizarMarcadores(e);
      return marcador;
    },
    set_marker_note(e, { clientId, note }) {
      const marcador = e.marcadores.find((m) => m.client_id === clientId);
      if (!marcador) throw "marcador não encontrado";
      marcador.note = note;
      sincronizarMarcadores(e);
      return marcador;
    },
    save_settings(e, { input }) {
      if (!/^https?:\/\/\S+$/.test(input.web_url)) throw "endereço inválido: use http:// ou https:// seguido do host";
      if (input.retention_days != null && input.retention_days > 3650) throw "retenção acima de 3650 dias";
      const mic = input.mic === undefined ? e.settings.mic : input.mic || null;
      const systemSource =
        input.system_source === undefined ? e.settings.system_source : input.system_source || "follow";
      if (mic === "none" && systemSource === "none") throw "Escolha ao menos uma fonte de áudio";
      e.ultimaEntrada = input;
      e.settings = {
        ...e.settings,
        web_url: input.web_url,
        api_url: input.api_url ?? null,
        ca_path: input.ca_path ?? null,
        detection_enabled: input.detection_enabled,
        retention_days: input.retention_days,
        pat_source: input.clear_pat ? null : input.pat ? "keyring" : e.settings.pat_source,
        mic,
        system_source: systemSource,
        note_silence_s: input.note_silence_s === undefined ? e.settings.note_silence_s : input.note_silence_s || null,
        shortcuts: input.shortcuts
          ? e.settings.shortcuts.map((a) => ({ ...a, keys: input.shortcuts[a.action] }))
          : e.settings.shortcuts,
        apps: e.settings.apps.map((a) => ({ ...a, policy: input.policies?.[a.app] ?? a.policy })),
      };
      return e.settings;
    },
    system_shortcuts(e, { install }) {
      for (const atalho of e.settings.shortcuts) {
        Object.assign(
          atalho,
          install
            ? { registration: "registered", problem: null }
            : { registration: "system", problem: "Crie o atalho no sistema" },
        );
      }
      return e.settings;
    },
    storage_info: (e) => e.armazenamento,
    open_help: () => null,
    dismiss_update_notice(e) {
      e.status.updated = null;
      return null;
    },
    open_log_dir: () => null,
    list_input_devices: (e) => e.microfones,
    list_output_devices: (e) => e.saidas,
    source_test(e) {
      e.testeDeNivel = 10;
      return null;
    },
    source_test_stop(e) {
      e.testeDeNivel = 0;
      return null;
    },
    source_test_meter(e) {
      if (e.testeDeNivel <= 0) return null;
      e.testeDeNivel -= 1;
      return [0.3, 0.6, 0.9, 0.7, 0.5, 0.3, 0.1, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
    },
    open_data_dir: () => null,
    sync_now: () => null,
    discover_servers: (e) => e.servidores,
    prepare_server(e, { url, caSha256 }) {
      if (url.includes("fora")) throw `não foi possível falar com o servidor em ${url}`;
      if (caSha256 && caSha256 !== CA) throw "a CA não confere com a impressão digital esperada";
      e.preparado = {
        name: "eclume",
        url,
        ca_sha256: caSha256 ?? "3f9a1c6e0b7d24f58e1a9c3b6d0f2e4a7c5b8d1e3f6a9c2b4d7e0f1a3c5e7b9d",
        // Como no Rust: só o endereço e a impressão digital do instalador dispensam a conferência.
        trusted_by: e.servidores.some((s) => s.origin === "installer" && s.url === url && s.ca_sha256 === caSha256)
          ? "fingerprint"
          : "first_use",
        confirmed: false,
      };
      return e.preparado;
    },
    confirm_server(e, { url }) {
      if (e.preparado?.url !== url) throw "O servidor escolhido mudou; confira a impressão digital de novo";
      e.preparado.confirmed = true;
      return null;
    },
    sign_in(e, { email, password }) {
      if (!e.preparado) throw "Escolha o servidor antes de entrar";
      if (e.preparado.trusted_by === "first_use" && !e.preparado.confirmed) throw "Confira a impressão digital do servidor antes de entrar";
      if (password === "errada") throw "E-mail ou senha incorretos";
      entrar(e, email);
      return null;
    },
    pair(e, { code }) {
      if (!e.preparado) throw "Escolha o servidor antes de entrar";
      if (e.preparado.trusted_by === "first_use" && !e.preparado.confirmed) throw "Confira a impressão digital do servidor antes de entrar";
      if (code.replace("-", "").toUpperCase() !== "K7Q4MX") throw "Código inválido ou vencido";
      entrar(e, CONTA.email);
      return null;
    },
    sign_out(e) {
      semConta(e);
      return null;
    },
    test_connection: (e) => e.testeDeConexao,
    open_signup: () => null,
    pick_ca_file: () => "/home/ana/caddy-root.pem",
  };

  function entrar(e, email) {
    const conta = { ...CONTA, email };
    for (const alvo of [e.status, e.settings]) {
      Object.assign(alvo, { connection: "account", account: conta, web_url: e.preparado.url });
    }
    e.settings.pat_source = "keyring";
    e.status.sync_notice = null;
  }

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
