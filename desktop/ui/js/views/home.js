// The home window (DS frame "Main window"): Recent panel at the top, status line,
// record, new voice note and import, the voice note meter, markers and app policy during
// automatic recording, the detected meeting prompt, upload queue and account.
import { el, replace, $ } from "../dom.js";
import { version } from "../tauri.js";
import { serverLabel } from "./first-run.js";
import { ESTADOS_APARELHO as DEVICE_STATES, fraseDaEspera as waitPhrase } from "../vocabulario.js";
import { mountRecent } from "../recent.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Queue state in the shared vocabulary (device states): `.badge` label and tone. */
const STATUSES = {
  recording: DEVICE_STATES.recording,
  pending: DEVICE_STATES.pending,
  syncing: DEVICE_STATES.uploading,
  synced: DEVICE_STATES.uploaded,
  failed: DEVICE_STATES.failed,
};

export const MAC = /Mac/.test(navigator.platform || navigator.userAgent);

/** The default global shortcuts, until settings arrive. */
const DEFAULT_SHORTCUTS = MAC
  ? { record: "Cmd+Shift+R", note: "Cmd+Shift+N", marker: "Cmd+Shift+K" }
  : { record: "Ctrl+Alt+R", note: "Ctrl+Alt+N", marker: "Ctrl+Alt+M" };

const MAC_SYMBOLS = { cmd: "⌘", command: "⌘", super: "⌘", shift: "⇧", alt: "⌥", option: "⌥", ctrl: "⌃", control: "⌃" };

/** A shortcut as the person reads it: "⌘⇧N" on macOS, "Ctrl+Alt+N" elsewhere. */
export function keys(shortcut, mac = MAC) {
  if (!mac) return shortcut;
  return shortcut
    .split("+")
    .map((part) => MAC_SYMBOLS[part.trim().toLowerCase()] ?? part.trim())
    .join("");
}

/** Meter bars below this level appear as silence. */
const QUIET_LEVEL = 0.15;

const hourMinute = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const dayMonth = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });

/** Today, yesterday or a date, followed by the time. */
export function when(ms, now = Date.now()) {
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const time = hourMinute.format(ms);
  if (ms >= dayStart) return `Hoje, ${time}`;
  if (ms >= dayStart - DAY) return `Ontem, ${time}`;
  return `${dayMonth.format(ms)}, ${time}`;
}

/** "42 s", "54 min" or "1 h 05 min". */
export function duration(ms) {
  if (ms == null) return null;
  if (ms < MIN) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const minutes = Math.round(ms / MIN);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** The elapsed recording time: "12:04" or "1:02:09". */
export function timer(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** The voice note time on the stop button: "00:00:42". */
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
}

/** The status line and its `data-status`. */
export function statusLine(state, detecting, now = Date.now()) {
  const remaining = state.counts.pending + state.counts.syncing + state.counts.failed;
  if (state.status === "recording" && state.recording_kind === "note") {
    const stop = state.note_silence_s ? ` · para depois de ${state.note_silence_s} s de silêncio` : "";
    return ["recording", `Gravando uma nota${stop}`];
  }
  if (state.status === "recording") {
    const elapsed = state.recording_started_at ? ` · ${timer(now - state.recording_started_at)}` : "";
    const origin = state.recording_app ? ` ${state.recording_app.label}` : "";
    return ["recording", `Gravando${origin}${elapsed}`];
  }
  if (state.status === "syncing") {
    return ["syncing", remaining === 1 ? "Enviando 1 gravação" : `Enviando ${remaining} gravações`];
  }
  if (state.meeting) return ["idle", `Reunião no ${state.meeting.label}`];
  if (detecting) return ["idle", "Ocioso, atento a reuniões"];
  if (remaining === 0) return ["synced", "Tudo enviado"];
  return ["idle", remaining === 1 ? "Ocioso · 1 gravação na fila" : `Ocioso · ${remaining} gravações na fila`];
}

function recordingLabel(recording, now) {
  // The title given when stopping, otherwise the one the server gave after processing (queue v5).
  const title = recording.title ?? recording.server_title ?? recording.original_name;
  const parts = [title ?? when(recording.started_at, now)];
  if (recording.kind === "note") parts.push("Nota");
  parts.push(duration(recording.duration_ms));
  if (recording.interrupted) parts.push("interrompida");
  return parts.filter(Boolean).join(" · ");
}

/** Singular or plural marker count. */
export function markerCount(n) {
  return n === 1 ? "1 marcador" : `${n} marcadores`;
}

export function mount(section, app) {
  const row = $("#line-status", section);
  const record = $("#record", section);
  const prompt = $("#prompt", section);
  const queue = $("#queue", section);
  const notice = $("#notice", section);
  const note = $("#note", section);
  const meter = $("#meter", section);
  const markers = $("#markers", section);
  const markerNote = $("#note-marker", section);
  const markerText = $("#note-marker-text", section);
  const policy = $("#policy", section);
  let settings = null;
  const recent = mountRecent($("#recent", section), app);

  // Updated to X (frame "After an update"): at the top of the window until dismissed.
  const updated = el(
    "div",
    { class: "alert alert-success", id: "updated", role: "status", hidden: true },
    el("span", { class: "alert-title", id: "updated-title" }),
    el("span", { id: "updated-notes" }),
    el(
      "button",
      {
        type: "button",
        class: "btn btn-ghost btn-sm",
        id: "updated-close",
        on: { click: () => execute("dismiss_update_notice") },
      },
      "Entendi",
    ),
  );
  $(".tray-section", section).prepend(updated);

  function drawUpdate(state) {
    const newUpdate = state.updated;
    updated.hidden = !newUpdate;
    if (!newUpdate) return;
    $("#updated-title", updated).textContent = `Atualizado para ${newUpdate.version}`;
    $("#updated-notes", updated).textContent = newUpdate.notes ?? "";
  }
  /** The last window command error; cleared by the next successful command. */
  let error = null;
  /** The marker whose note the field shows. */
  let editedMarker = null;
  /** The meter poll, every 100 ms while a voice note is active. */
  let meterPoll = null;

  const bars = Array.from({ length: 16 }, () => el("i"));
  replace(meter, bars);

  function drawShortcuts() {
    const shortcuts = { ...DEFAULT_SHORTCUTS };
    for (const shortcut of settings?.shortcuts ?? []) shortcuts[shortcut.action] = shortcut.keys;
    $("#shortcut-note", section).textContent = keys(shortcuts.note);
    $("#shortcut-marker", section).textContent = keys(shortcuts.marker);
  }
  drawShortcuts();

  function drawMeter(reading) {
    reading.levels.forEach((level, i) => {
      bars[i].style.setProperty("--h", `${Math.round(Math.max(0.08, level) * 100)}%`);
      bars[i].toggleAttribute("data-quiet", level < QUIET_LEVEL);
    });
    $("#note-silence", section).textContent =
      reading.stops_in_ms == null ? "" : `Silêncio · para em ${Math.max(1, Math.ceil(reading.stops_in_ms / 1000))} s`;
    record.textContent = `Parar nota · ${clock(reading.position_ms)}`;
  }

  async function pollMeter() {
    try {
      const reading = await app.invoke("note_meter");
      if (reading) drawMeter(reading);
    } catch (failure) {
      console.error(failure);
    }
  }

  function watchNote(enable) {
    if (enable && !meterPoll) {
      meterPoll = setInterval(pollMeter, 100);
      pollMeter();
    } else if (!enable && meterPoll) {
      clearInterval(meterPoll);
      meterPoll = null;
    }
  }

  function drawNotice(state) {
    const [title, text, tone] = error
      ? ["Não deu certo", error, "alert-error"]
      : state.notice
        ? ["Aviso", state.notice, "alert-warning"]
        : ["Envio", state.sync_notice, "alert-warning"];
    notice.hidden = !text;
    notice.className = `alert ${tone}`;
    $("#notice-title", notice).textContent = title;
    $("#notice-text", notice).textContent = text ?? "";
  }

  async function execute(command, args) {
    try {
      const response = await app.invoke(command, args);
      error = null;
      return response;
    } catch (failure) {
      error = String(failure);
      return null;
    } finally {
      app.refresh();
    }
  }

  record.addEventListener("click", async () => {
    record.disabled = true;
    await execute(app.state?.recording_kind === "note" ? "new_note" : "toggle_recording");
    record.disabled = false;
  });
  $("#marker", section).addEventListener("click", async () => {
    const marker = await execute("add_marker", { note: null });
    if (marker) {
      editedMarker = marker;
      markerText.value = "";
      markerNote.hidden = false;
      markerText.focus();
    }
  });
  markerText.addEventListener("change", () => {
    if (!editedMarker) return;
    const text = markerText.value.trim();
    execute("set_marker_note", { clientId: editedMarker.client_id, note: text || null });
  });
  markerText.addEventListener("keydown", (event) => {
    if (event.key === "Enter") markerText.blur();
  });
  $("#policy-options", section).addEventListener("change", (event) => changePolicy(event.target.value));
  $("#policy-settings", section).addEventListener("click", (event) => {
    event.preventDefault();
    app.go("settings", { tab: "meetings" });
  });
  $("#new-note", section).addEventListener("click", () => execute("new_note"));
  $("#import", section).addEventListener("click", () => app.importFile());
  $("#open-settings", section).addEventListener("click", () => app.go("settings"));
  $("#prompt-record", section).addEventListener("click", () => execute("answer_meeting", { record: true }));
  $("#prompt-now-no", section).addEventListener("click", () => execute("answer_meeting", { record: false }));
  $("#account-server", section).addEventListener("click", (event) => {
    event.preventDefault();
    execute("open_web");
  });
  $("#account-action", section).addEventListener("click", async (event) => {
    event.preventDefault();
    if (app.state?.connection === "account") {
      await execute("sign_out");
    } else {
      app.go("settings", { tab: "server" });
    }
  });

  /** Change the app policy for the ongoing automatic recording, using saved settings. */
  async function changePolicy(value) {
    const recordingApp = app.state?.recording_app?.app;
    if (!recordingApp) return;
    const currentSettings = await execute("settings");
    if (!currentSettings) return;
    const policies = Object.fromEntries(currentSettings.apps.map((a) => [a.app, a.app === recordingApp ? value : a.policy]));
    const saved = await execute("save_settings", {
      input: {
        web_url: currentSettings.web_url,
        api_url: currentSettings.api_url,
        ca_path: currentSettings.ca_path,
        detection_enabled: currentSettings.detection_enabled,
        policies,
        retention_days: currentSettings.retention_days,
      },
    });
    if (saved) settings = saved;
  }

  function drawRecording(state) {
    const isRecording = state.status === "recording";
    const inNote = isRecording && state.recording_kind === "note";
    record.setAttribute("aria-pressed", String(isRecording));
    if (!inNote) record.textContent = isRecording ? "Parar gravação" : "Iniciar gravação";
    note.hidden = !inNote;
    watchNote(inNote);

    $("#recording-automatic", section).hidden = !(isRecording && state.recording_auto);
    markers.hidden = !isRecording;
    const count = $("#count-markers", section);
    count.hidden = !state.marker_count;
    count.textContent = markerCount(state.marker_count ?? 0);
    const last = isRecording ? state.last_marker : null;
    markerNote.hidden = !last;
    if (last && last.client_id !== editedMarker?.client_id) {
      editedMarker = last;
      markerText.value = last.note ?? "";
    }
    if (last) $("#note-marker-label", section).textContent = `Nota do marcador em ${timer(last.at_ms)}`;
    if (!isRecording) editedMarker = null;

    const appAuto = isRecording && state.recording_auto ? state.recording_app : null;
    policy.hidden = !appAuto;
    if (appAuto) {
      $("#policy-title", policy).textContent = `Reuniões no ${appAuto.label.replace(/^Microsoft /, "")}`;
      $("#policy-options", policy).setAttribute("aria-label", appAuto.label);
      const current = settings?.apps.find((a) => a.app === appAuto.app)?.policy;
      for (const option of policy.querySelectorAll("input")) option.checked = option.value === current;
    }
  }

  /** The account, as in frame "Main window": email and server label, version and sign-out. */
  function drawAccount(state) {
    const account = state.account;
    $("#account-name", section).textContent = account?.email ?? "Conectado com um token pessoal";
    $("#account-server", section).textContent = serverLabel({ name: account?.server_name, url: state.web_url });
    $("#account-action", section).textContent = state.connection === "account" ? "Sair" : "Servidor";
  }

  function drawQueue(recordings, waits, now) {
    replace(
      queue,
      recordings.map((recording) => {
        const { rotulo: label, tom: tone } = STATUSES[recording.status] ?? { rotulo: recording.status, tom: "neutral" };
        const error = recording.status === "failed" && recording.last_error;
        // Uploaded less than 24 h ago with transcription queued on the server: why it waits.
        const wait = recording.status === "synced" && waitPhrase(waits?.[recording.remote_id], new Date(now));
        return el(
          "li",
          { dataset: { id: recording.id } },
          el("span", {}, recordingLabel(recording, now)),
          el("span", { class: tone === "neutral" ? "badge" : `badge badge-${tone}` }, label),
          error ? el("span", { class: "queue-error" }, error) : null,
          wait ? el("span", { class: "queue-wait" }, wait) : null,
        );
      }),
    );
    $("#queue-empty", section).hidden = recordings.length > 0;
    const uploaded = recordings.filter((g) => g.status === "synced").length;
    $("#queue-summary", section).textContent = recordings.length ? `${uploaded} de ${recordings.length} enviadas` : "";
  }

  return {
    leave() {
      watchNote(false);
    },

    async enter() {
      const [loaded, number] = await Promise.all([app.invoke("settings"), version()]);
      settings = loaded;
      $("#account-version", section).textContent = `v${number}`;
      drawShortcuts();
      if (app.state) this.refresh(app.state, app.queue);
      // The panel reads the server now, without waiting for the next loop iteration.
      app.invoke("recent_refresh").catch((failure) => console.error(failure));
    },

    refresh(state, recordings) {
      const now = Date.now();
      const [status, text] = statusLine(state, settings?.detection_enabled ?? false, now);
      row.dataset.status = status;
      row.textContent = text;

      drawRecording(state);

      prompt.hidden = !state.pending_ask;
      if (state.pending_ask) {
        $("#prompt-text", prompt).textContent = `${state.pending_ask.label} está usando o microfone. Gravar?`;
      }

      drawNotice(state);
      drawUpdate(state);
      drawAccount(state);
      drawQueue(recordings, state.queue_waits, now);
      recent.draw(app.recent);
    },
  };
}
