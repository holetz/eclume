// Mock Tauri for desktop UI browser tests. Define `window.__TAURI__` (as exposed by
// `withGlobalTauri`) with `core.invoke` and `event.listen`, and `window.__mock` for tests:
// `scenario(name)` changes state, `emit(event, payload)` fires a Rust event, and
// `calls` records commands for frozen fixtures; `window.__MOCK_SCENARIO` sets the initial scenario.
(() => {
  const now = Date.now();
  const MIN = 60_000;
  const today = (h, m) => {
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };

  function recording(id, extra) {
    return {
      id,
      path: `/dados/gravacoes/${id}.ogg`,
      started_at: today(9, 0),
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
      synced_at: now,
      purged_at: null,
      meeting_app: null,
      title: null,
      server_title: null,
      ...extra,
    };
  }

  /** A Recent panel row, as returned by the Rust `recent` command. */
  function recentItem(key, extra) {
    return {
      key,
      remote_id: key.startsWith("local:") ? null : key,
      local_id: key.startsWith("local:") ? key.slice(6) : null,
      title: "",
      started_at: null,
      created_at: new Date(today(8, 0)).toISOString(),
      duration_ms: null,
      phase: "summary_ready",
      stage: null,
      progress: null,
      attention: null,
      reason: null,
      detail: null,
      wait: null,
      ...extra,
    };
  }

  const CA = "98e209f5457514b7b12ec349d22b3b0d93c03c3f10e52350ea5f9e0b3d97792f";
  const ACCOUNT = { email: "ana@exemplo.com.br", token_id: "t-1", server_name: "eclume" };

  function base() {
    return {
      status: {
        status: "idle",
        recording_id: null,
        recording_started_at: null,
        recording_kind: null,
        note_silence_s: 4,
        theme: "system",
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
        queue_waits: {},
        updated: null,
        connection: "account",
        account: ACCOUNT,
      },
      recordings: [
        recording("a", { started_at: today(9, 0), duration_ms: 54 * MIN }),
        recording("b", { started_at: today(8, 18), duration_ms: 1 * MIN }),
        recording("c", { started_at: today(8, 18) - 24 * 60 * MIN + 8 * 60 * MIN, duration_ms: 22 * MIN }),
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
          ["whatsapp", "WhatsApp", "ask"],
          ["navegador", "navegador", "ask"],
          ["outro", "outro app", "ignore"],
        ].map(([app, label, policy]) => ({ app, label, policy, default_policy: app === "outro" ? "ignore" : "ask" })),
        retention_days: 7,
        pat_source: "keyring",
        connection: "account",
        account: ACCOUNT,
        shortcuts: [
          ["record", "Iniciar ou parar a gravação", "Ctrl+Alt+R"],
          ["note", "Nova nota", "Ctrl+Alt+N"],
          ["marker", "Adicionar marcador", "Ctrl+Alt+M"],
        ].map(([action, label, keys]) => ({ action, label, keys, registration: "registered", problem: null })),
        shortcut_mode: { mode: "global" },
        mic: null,
        system_source: "follow",
        language: null,
        theme: "system",
        notify_summary: true,
        autostart: true,
        recent_count: 5,
        tray_recent_count: 1,
        mirror_enabled: false,
        mirror_dir: null,
        mirror_transcripts: true,
        note_silence_s: 4,
      },
      mirror: { running: false, last_sync_ms: null, last_error: null, last: null },
      recent: { items: [], fetched_at: now, error: null },
      /** The current summary Markdown for each recording, for `copy_summary`. */
      summaries: {},
      clipboard: null,
      openedRecording: null,
      microphones: { default: "Microfone embutido", names: ["Microfone embutido", "Jabra Evolve2 65"] },
      outputs: {
        default: "alsa_output.pci-0000_00_1f.3.analog-stereo",
        devices: [
          { id: "alsa_output.pci-0000_00_1f.3.analog-stereo", name: "Alto-falantes embutidos" },
          { id: "bluez_output.jabra", name: "Jabra Evolve2 65" },
        ],
      },
      levelTest: 0,
      markers: [],
      storage: { dir: "/home/ana/.local/share/eclume/gravacoes", recordings: 3, bytes: 41_200_000 },
      importing: {
        chosen: "/home/ana/kickoff-guion.m4a",
        files: {
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
            recorded_at: now,
            date_origin: "file_mtime",
          },
        },
        request: null,
        failure: null,
        hold: false,
        cancelled: false,
      },
      meter: {
        position_ms: 42_000,
        levels: [0.3, 0.55, 0.8, 0.65, 0.9, 0.45, 0.7, 0.35, 0.2, 0.1, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05],
        stops_in_ms: 2_400,
      },
      version: "0.2.0",
      servers: [
        { name: "192.168.15.199", url: "https://192.168.15.199:8443", ca_sha256: CA, origin: "installer" },
        { name: "Escritório", url: "https://10.0.0.2", ca_sha256: CA, origin: "network" },
      ],
      prepared: null,
      connectionTest: { email: ACCOUNT.email, last_upload_at: new Date(2026, 8, 27, 10, 38).getTime() },
    };
  }

  /** No credential: the window opens on first run. */
  function noAccount(e) {
    for (const target of [e.status, e.settings]) Object.assign(target, { connection: "first_run", account: null });
    e.settings.pat_source = null;
  }

  const scenarios = {
    idle() {},
    isRecording(e) {
      Object.assign(e.status, {
        status: "recording",
        recording_id: "r1",
        recording_started_at: now - (12 * MIN + 4_000),
        recording_auto: true,
        recording_app: { app: "teams", label: "Microsoft Teams" },
        meeting: { app: "teams", label: "Microsoft Teams" },
      });
      e.recordings.unshift(recording("r1", { status: "recording", started_at: now - 12 * MIN, duration_ms: null }));
    },
    note(e) {
      Object.assign(e.status, {
        status: "recording",
        recording_id: "n1",
        recording_started_at: now - 42_000,
        recording_kind: "note",
      });
      e.recordings.unshift(recording("n1", { status: "recording", kind: "note", started_at: now - 42_000, duration_ms: null }));
    },
    markers(e) {
      scenarios.isRecording(e);
      e.status.recording_auto = false;
      e.status.recording_app = null;
      e.markers = [
        { client_id: "m1", recording_id: "r1", at_ms: 125_000, note: "decisão do orçamento", created_at: now - 60_000 },
      ];
      syncMarkers(e);
    },
    prompt(e) {
      e.status.meeting = { app: "zoom", label: "Zoom" };
      e.status.pending_ask = { app: "zoom", label: "Zoom" };
    },
    queue(e) {
      e.status.counts = { recording: 0, pending: 1, syncing: 1, synced: 1, failed: 1 };
      e.recordings = [
        recording("s", { status: "syncing", started_at: today(9, 0) }),
        recording("n", { status: "synced", started_at: today(8, 18), duration_ms: 1 * MIN, kind: "note" }),
        recording("f", { status: "failed", last_error: "HTTP 413: arquivo grande demais" }),
        recording("i", { status: "pending", original_name: "kickoff-guion", duration_ms: 47 * MIN }),
      ];
    },
    titles(e) {
      e.recordings[0].server_title = "Alinhamento semanal";
      e.recordings[1].title = "Ideia do orçamento";
      e.recordings[1].server_title = "Nota de voz";
    },
    wait(e) {
      const processor = { online: true, offline_since: null };
      e.status.queue_waits = {
        "srv-a": { reason: "account_turn", ahead: null, account_ahead: 2, estimated_start_at: null, resumes_at: null, processor: processor },
        "srv-b": {
          reason: "processor_queue",
          ahead: 0,
          account_ahead: null,
          estimated_start_at: null,
          resumes_at: null,
          processor: { online: false, offline_since: null },
        },
      };
    },
    recent(e) {
      e.recent.items = [
        recentItem("local:g1", { phase: "recording", started_at: today(10, 5), created_at: null }),
        recentItem("local:f1", {
          phase: "upload_failed",
          attention: "upload_failed",
          title: "Kickoff Guion",
          detail: "HTTP 413: arquivo grande demais",
        }),
        recentItem("srv-t", { phase: "transcribing", title: "Alinhamento semanal", stage: "asr", progress: 420 }),
        recentItem("srv-r", { phase: "summary_ready", title: "Comitê de crédito" }),
        recentItem("srv-l", {
          phase: "unknown",
          attention: "needs_you",
          title: "Reunião com a diretoria",
          stage: "speakers",
          detail: "waiting",
          reason: "unnamed_speakers",
        }),
        recentItem("srv-s", { phase: "summary_failed", attention: "summary_failed", title: "1:1 com a Bia" }),
        recentItem("srv-q", {
          phase: "queued",
          title: "Daily do time",
          wait: { reason: "processor_queue", ahead: 1, account_ahead: null, estimated_start_at: null, resumes_at: null, processor: null },
        }),
      ];
      e.summaries = { "srv-r": "# Comitê de crédito\n\n- Aprovado o limite da cooperativa" };
    },
    updated(e) {
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
      for (const shortcut of e.settings.shortcuts) {
        Object.assign(shortcut, { registration: "system", problem: "Crie o atalho no sistema" });
      }
    },
    shortcutInUse(e) {
      Object.assign(e.settings.shortcuts[1], { registration: "in_use", problem: "Em uso por outro app" });
      e.settings.mic = "Headset antigo";
    },
    empty(e) {
      e.recordings = [];
      e.status.counts = { recording: 0, pending: 0, syncing: 0, synced: 0, failed: 0 };
      e.settings.detection_enabled = false;
      e.status.sync_notice = "Falha ao sincronizar: o servidor respondeu 503";
    },
    pat(e) {
      for (const target of [e.status, e.settings]) Object.assign(target, { connection: "personal_token", account: null });
    },
    firstRun: noAccount,
    noServer(e) {
      noAccount(e);
      e.servers = [];
    },
    caChanged(e) {
      noAccount(e);
      e.status.sync_notice = "O certificado do servidor mudou";
    },
  };

  function syncMarkers(e) {
    e.status.marker_count = e.markers.length;
    e.status.last_marker = e.markers.at(-1) ?? null;
  }

  const listeners = new Map();
  const mock = {
    state: base(),
    calls: [],
    scenario(name) {
      const apply = scenarios[name];
      if (!apply) throw new Error(`unknown scenario: ${name}`);
      mock.state = base();
      apply(mock.state);
      mock.emit("status-changed");
    },
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler({ event: event, payload });
    },
  };

  const commands = {
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
    pick_import_file: (e) => e.importing.chosen,
    probe_import(e, { path }) {
      const probed = e.importing.files[path];
      if (!probed) throw `arquivo ilegível: ${path}`;
      return { path, ...probed };
    },
    import_file(e, args) {
      e.importing.request = args;
      if (e.importing.failure) {
        setTimeout(() => mock.emit("import-failed", e.importing.failure), 20);
        return null;
      }
      setTimeout(() => mock.emit("import-progress", 0.5), 10);
      if (!e.importing.hold) setTimeout(() => mock.emit("import-finished", "imp-1"), 30);
      return null;
    },
    cancel_import(e) {
      e.importing.cancelled = true;
      return null;
    },
    note_meter: (e) => (e.status.recording_kind === "note" ? e.meter : null),
    add_marker(e, { note }) {
      if (e.status.status !== "recording") throw "nenhuma gravação em andamento";
      const marker = {
        client_id: `m${e.markers.length + 1}`,
        recording_id: e.status.recording_id,
        at_ms: 60_000 * (e.markers.length + 1),
        note: note ?? null,
        created_at: Date.now(),
      };
      e.markers.push(marker);
      syncMarkers(e);
      return marker;
    },
    set_marker_note(e, { clientId, note }) {
      const marker = e.markers.find((m) => m.client_id === clientId);
      if (!marker) throw "marcador não encontrado";
      marker.note = note;
      syncMarkers(e);
      return marker;
    },
    save_settings(e, { input }) {
      if (!/^https?:\/\/\S+$/.test(input.web_url)) throw "endereço inválido: use http:// ou https:// seguido do host";
      if (input.retention_days != null && input.retention_days > 3650) throw "retenção acima de 3650 dias";
      const mic = input.mic === undefined ? e.settings.mic : input.mic || null;
      const systemSource =
        input.system_source === undefined ? e.settings.system_source : input.system_source || "follow";
      if (mic === "none" && systemSource === "none") throw "Escolha ao menos uma fonte de áudio";
      const mirrorDir = input.mirror_dir === undefined ? e.settings.mirror_dir : input.mirror_dir || null;
      const mirrorEnabled = input.mirror_enabled ?? e.settings.mirror_enabled;
      if (mirrorEnabled && !mirrorDir) throw "Escolha a pasta dos resumos para ligar a sincronização";
      e.lastInput = input;
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
        language: input.language === undefined ? e.settings.language : input.language || null,
        theme: input.theme ?? e.settings.theme,
        notify_summary: input.notify_summary ?? e.settings.notify_summary,
        autostart: input.autostart ?? e.settings.autostart,
        recent_count: input.recent_count ?? e.settings.recent_count,
        tray_recent_count: input.tray_recent_count ?? e.settings.tray_recent_count,
        mirror_enabled: mirrorEnabled,
        mirror_dir: mirrorDir,
        mirror_transcripts: input.mirror_transcripts ?? e.settings.mirror_transcripts,
        shortcuts: input.shortcuts
          ? e.settings.shortcuts.map((a) => ({ ...a, keys: input.shortcuts[a.action] }))
          : e.settings.shortcuts,
        apps: e.settings.apps.map((a) => ({ ...a, policy: input.policies?.[a.app] ?? a.policy })),
      };
      e.status.theme = e.settings.theme;
      return e.settings;
    },
    system_shortcuts(e, { install }) {
      for (const shortcut of e.settings.shortcuts) {
        Object.assign(
          shortcut,
          install
            ? { registration: "registered", problem: null }
            : { registration: "system", problem: "Crie o atalho no sistema" },
        );
      }
      return e.settings;
    },
    storage_info: (e) => e.storage,
    open_help: () => null,
    dismiss_update_notice(e) {
      e.status.updated = null;
      return null;
    },
    open_log_dir: () => null,
    list_input_devices: (e) => e.microphones,
    list_output_devices: (e) => e.outputs,
    source_test(e) {
      e.levelTest = 10;
      return null;
    },
    source_test_stop(e) {
      e.levelTest = 0;
      return null;
    },
    source_test_meter(e) {
      if (e.levelTest <= 0) return null;
      e.levelTest -= 1;
      return [0.3, 0.6, 0.9, 0.7, 0.5, 0.3, 0.1, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
    },
    open_data_dir: () => null,
    sync_now: () => null,
    discover_servers: (e) => e.servers,
    prepare_server(e, { url, caSha256 }) {
      if (url.includes("fora")) throw `não foi possível falar com o servidor em ${url}`;
      if (caSha256 && caSha256 !== CA) throw "a CA não confere com a impressão digital esperada";
      e.prepared = {
        name: "eclume",
        url,
        ca_sha256: caSha256 ?? "3f9a1c6e0b7d24f58e1a9c3b6d0f2e4a7c5b8d1e3f6a9c2b4d7e0f1a3c5e7b9d",
        // As in Rust: only the installer address and fingerprint skip the manual check.
        trusted_by: e.servers.some((s) => s.origin === "installer" && s.url === url && s.ca_sha256 === caSha256)
          ? "fingerprint"
          : "first_use",
        confirmed: false,
      };
      return e.prepared;
    },
    confirm_server(e, { url }) {
      if (e.prepared?.url !== url) throw "O servidor escolhido mudou; confira a impressão digital de novo";
      e.prepared.confirmed = true;
      return null;
    },
    sign_in(e, { email, password }) {
      if (!e.prepared) throw "Escolha o servidor antes de entrar";
      if (e.prepared.trusted_by === "first_use" && !e.prepared.confirmed) throw "Confira a impressão digital do servidor antes de entrar";
      if (password === "errada") throw "E-mail ou senha incorretos";
      enter(e, email);
      return null;
    },
    pair(e, { code }) {
      if (!e.prepared) throw "Escolha o servidor antes de entrar";
      if (e.prepared.trusted_by === "first_use" && !e.prepared.confirmed) throw "Confira a impressão digital do servidor antes de entrar";
      if (code.replace("-", "").toUpperCase() !== "K7Q4MX") throw "Código inválido ou vencido";
      enter(e, ACCOUNT.email);
      return null;
    },
    sign_out(e) {
      noAccount(e);
      return null;
    },
    test_connection: (e) => e.connectionTest,
    account_language: () => "pt",
    open_signup: () => null,
    pick_ca_file: () => "/home/ana/caddy-root.pem",
    pick_mirror_dir: () => "/home/ana/Obsidian/eclume",
    mirror_status: (e) => e.mirror,
    recent(e) {
      const count = e.settings.recent_count;
      const items = e.recent.items.slice(0, count);
      return { count, items, needs_you: items.filter((i) => i.attention).length, fetched_at: e.recent.fetched_at, error: e.recent.error };
    },
    recent_refresh: () => null,
    copy_summary(e, { recordingId }) {
      const markdown = e.summaries[recordingId];
      if (!markdown) throw "O resumo ainda não está pronto";
      e.clipboard = markdown;
      return null;
    },
    open_recording(e, { recordingId }) {
      e.openedRecording = recordingId;
      return null;
    },
    mirror_sync_now(e) {
      e.mirror = { running: false, last_sync_ms: Date.UTC(2026, 8, 29, 13, 42), last_error: null, last: { recordings: 12, written: 24, unchanged: 0, removed: 0, failed: 0 } };
      return null;
    },
  };

  function enter(e, email) {
    const account = { ...ACCOUNT, email };
    for (const target of [e.status, e.settings]) {
      Object.assign(target, { connection: "account", account: account, web_url: e.prepared.url });
    }
    e.settings.pat_source = "keyring";
    e.status.sync_notice = null;
  }

  window.__mock = mock;
  window.__TAURI__ = {
    core: {
      async invoke(command, args) {
        mock.calls.push({ command, args: args ?? null });
        const handler = commands[command];
        if (!handler) throw `command without a mock: ${command}`;
        return structuredClone(handler(mock.state, args ?? {}));
      },
    },
    app: {
      async getVersion() {
        return mock.state.version;
      },
    },
    event: {
      async listen(event, handler) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(handler);
        return () => listeners.get(event).delete(handler);
      },
    },
  };

  const initial = scenarios[window.__MOCK_SCENARIO] ? window.__MOCK_SCENARIO : "idle";
  scenarios[initial](mock.state);
})();
