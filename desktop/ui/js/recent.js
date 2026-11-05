// The Recent panel at the top of home: the account’s last N recordings (the `recent` command,
// built in Rust from the local queue and API), each in a row with its state, progress,
// an alert when the person needs to act and a row action — Copy summary, Open on web or
// Try now. Labels come from the shared vocabulary; state is never conveyed by color alone.
import { el, replace, $ } from "./dom.js";
import { fillIcons } from "./icons.js";
import { ESTADOS_APARELHO as DEVICE_STATES, ESTADOS_SERVIDOR as SERVER_STATES, ESTADOS_ETAPA as STAGE_STATES, ETAPAS as STAGES, motivo as reason, nomeDaEtapa as stageName, fraseDaEspera as waitPhrase } from "./vocabulario.js";

/** How long action feedback (Copied or an error) stays in the row. */
const FEEDBACK_MS = 2500;

/** Singular or plural count of recordings needing attention. */
export function alertCount(n) {
  return n === 1 ? "1 precisa de você" : `${n} precisam de você`;
}

/** The label while a stage runs (Summarizing), or its name. */
function progressText(stage) {
  return STAGES.find((item) => item.etapa === stage)?.andamento ?? stageName(stage);
}

/** The label and tone of a row’s `.badge`, by the phase Rust classified.
 * @returns {{ rotulo: string, tom: string }} */
export function status(item) {
  switch (item.phase) {
    case "recording":
      return DEVICE_STATES.recording;
    case "pending":
      return DEVICE_STATES.pending;
    case "uploading":
      return DEVICE_STATES.uploading;
    case "upload_failed":
      return DEVICE_STATES.failed;
    case "uploaded":
      return DEVICE_STATES.uploaded;
    case "queued":
      return SERVER_STATES.na_fila;
    case "transcribing":
      return { rotulo: progressText("transcription"), tom: "progress" };
    case "processing":
      return { rotulo: item.stage ? progressText(item.stage) : SERVER_STATES.em_andamento.rotulo, tom: "progress" };
    case "summary_ready":
      return { rotulo: "Resumo pronto", tom: "success" };
    case "transcribed":
      return SERVER_STATES.pronta;
    case "no_summary":
      return { rotulo: "Pronta sem resumo", tom: item.attention ? "warning" : "neutral" };
    case "summary_failed":
      return { rotulo: "O resumo falhou", tom: "danger" };
    case "transcription_failed":
      return { rotulo: "A transcrição falhou", tom: "danger" };
    case "cancelled":
      return SERVER_STATES.cancelada;
    default: {
      // The `speakers` stage in `waiting` (contract 2.22.0) arrives here as an Awaiting speakers
      // alert with a link to the web. For an unknown state (from a newer server),
      // use its vocabulary label if available, otherwise the Needs you label.
      if (item.stage === "speakers" && item.detail === "waiting") return SERVER_STATES.aguardando_locutores;
      const known = SERVER_STATES[item.detail]?.rotulo;
      return { rotulo: known ?? "Precisa de você", tom: "warning" };
    }
  }
}

/** The detail line under a recording: the alert reason, the wait or nothing. */
export function detail(item, now = new Date()) {
  switch (item.phase) {
    case "upload_failed":
      return item.detail ?? "O envio falhou; o app tenta de novo sozinho.";
    case "queued":
      return waitPhrase(item.wait, now);
    case "no_summary":
      return item.reason ? reason(item.reason) : null;
    case "summary_failed":
      return "Abra no web para gerar o resumo de novo.";
    case "transcription_failed":
      return item.attention ? "Abra no web para ver o motivo." : "Falha passageira; o servidor tenta de novo.";
    case "unknown": {
      const stage = item.stage ? `${stageName(item.stage)}: ` : "";
      const state = STAGE_STATES[item.detail] ?? item.detail ?? "";
      const reasonText = item.reason ? ` · ${reason(item.reason)}` : "";
      return `${stage}${state}${reasonText} · resolva no web.`;
    }
    default:
      return null;
  }
}

function twoDigits(n) {
  return String(n).padStart(2, "0");
}

/** "05/10 14:02": the date of a row without a title. */
export function shortDate(instant) {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "Gravação";
  return `${twoDigits(date.getDate())}/${twoDigits(date.getMonth() + 1)} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

function titleOf(item) {
  if (item.title?.trim()) return item.title;
  return shortDate(item.started_at ?? item.created_at);
}

/** Mount the panel in `root` (home’s `#recent`). */
export function mountRecent(root, app) {
  const list = $("#recent-list", root);
  const alert = $("#recent-alert", root);
  const empty = $("#recent-empty", root);
  /** Per-row action feedback (key → { text, error, until }), preserved across redraws. */
  const feedbackByKey = new Map();
  let last = null;

  function notify(key, text, error = false) {
    feedbackByKey.set(key, { text, message: text, error, until: Date.now() + FEEDBACK_MS });
    draw(last);
    setTimeout(() => draw(last), FEEDBACK_MS + 50);
  }

  async function act(key, command, args, success) {
    try {
      await app.invoke(command, args);
      if (success) notify(key, success);
    } catch (failure) {
      notify(key, String(failure), true);
    }
  }

  function action(item) {
    const key = item.key;
    if (item.phase === "summary_ready" && item.remote_id) {
      const feedback = feedbackByKey.get(key);
      const copied = feedback && !feedback.error;
      const button = el(
        "button",
        {
          type: "button",
          class: "btn btn-secondary btn-sm recent-copy",
          dataset: { icon: "copy" },
          on: {
            click: () => act(key, "copy_summary", { recordingId: item.remote_id }, "Resumo copiado em Markdown."),
          },
        },
        copied ? "Copiado" : "Copiar resumo",
      );
      return button;
    }
    if (item.attention === "upload_failed") {
      return el(
        "button",
        { type: "button", class: "btn btn-ghost btn-sm", on: { click: () => act(key, "sync_now", undefined, "Enviando…") } },
        "Tentar agora",
      );
    }
    if (item.attention && item.remote_id) {
      return el(
        "button",
        {
          type: "button",
          class: "btn btn-ghost btn-sm",
          on: { click: () => act(key, "open_recording", { recordingId: item.remote_id }) },
        },
        "Abrir no web",
      );
    }
    return null;
  }

  function progress(item) {
    if (item.phase !== "transcribing" || item.progress == null) return null;
    const percent = Math.round(item.progress / 10);
    return el(
      "span",
      { class: "recent-progress" },
      el("progress", { class: "progress", max: 100, value: percent, "aria-label": `Transcrição ${percent}%` }),
      el("span", { class: "mono tiny" }, `${percent}%`),
    );
  }

  function row(item, now) {
    const { rotulo: label, tom: tone } = status(item);
    const feedback = feedbackByKey.get(item.key);
    const text = feedback?.error ? feedback.text : detail(item, now);
    return el(
      "li",
      { dataset: { key: item.key, phase: item.phase }, class: item.attention ? "recent-item recent-alert" : "recent-item" },
      el("span", { class: "recent-title", title: titleOf(item) }, titleOf(item)),
      el("span", { class: tone === "neutral" ? "badge" : `badge badge-${tone}` }, label),
      action(item) ?? el("span"),
      progress(item),
      text ? el("span", { class: feedback?.error || item.attention ? "recent-detail recent-reason" : "recent-detail" }, text) : null,
      feedback && !feedback.error ? el("span", { class: "recent-detail", role: "status" }, feedback.message) : null,
    );
  }

  function draw(panel) {
    last = panel;
    const now = Date.now();
    for (const [key, feedback] of feedbackByKey) if (feedback.until < now) feedbackByKey.delete(key);
    root.hidden = !panel || panel.count === 0;
    if (root.hidden) return;
    const items = panel.items ?? [];
    replace(
      list,
      items.map((item) => row(item, new Date(now))),
    );
    fillIcons(list);
    alert.hidden = !panel.needs_you;
    alert.textContent = panel.needs_you ? alertCount(panel.needs_you) : "";
    empty.hidden = items.length > 0;
    empty.textContent = panel.error && !panel.fetched_at ? "Sem resposta do servidor; tentando de novo." : "Nenhuma gravação ainda.";
  }

  return { draw };
}
