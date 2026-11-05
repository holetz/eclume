// The Recent panel at the top of home: the account’s last N recordings (the `recent` command,
// built in Rust from the local queue and API), each in a row with its state, progress,
// an alert when the person needs to act and a row action — Copy summary, Open on web or
// Try now. Labels come from the shared vocabulary; state is never conveyed by color alone.
import { el, replace, $ } from "./dom.js";
import { fillIcons } from "./icons.js";
import { deviceStates, serverStates, stepStates, steps, reasons, waitingPhrase as waitPhrase } from "./vocabulary.js";
import { t } from "./i18n.js";

function reason(code) {
  return reasons()[code] ?? code;
}

function stageName(stage) {
  return steps().find((item) => item.etapa === stage)?.nome ?? stage;
}

/** How long action feedback (Copied or an error) stays in the row. */
const FEEDBACK_MS = 2500;

/** Singular or plural count of recordings needing attention. */
export function alertCount(n) {
  return t("recent.alertCount", { count: n });
}

/** The label while a stage runs (Summarizing), or its name. */
function progressText(stage) {
  return steps().find((item) => item.etapa === stage)?.andamento ?? stageName(stage);
}

/** The label and tone of a row’s `.badge`, by the phase Rust classified.
 * @returns {{ rotulo: string, tom: string }} */
export function status(item) {
  switch (item.phase) {
    case "recording":
      return deviceStates().recording;
    case "pending":
      return deviceStates().pending;
    case "uploading":
      return deviceStates().uploading;
    case "upload_failed":
      return deviceStates().failed;
    case "uploaded":
      return deviceStates().uploaded;
    case "queued":
      return serverStates().na_fila;
    case "transcribing":
      return { rotulo: progressText("transcription"), tom: "progress" };
    case "processing":
      return { rotulo: item.stage ? progressText(item.stage) : serverStates().em_andamento.rotulo, tom: "progress" };
    case "summary_ready":
      return { rotulo: t("recent.summaryReady"), tom: "success" };
    case "transcribed":
      return serverStates().pronta;
    case "no_summary":
      return { rotulo: t("recent.noSummary"), tom: item.attention ? "warning" : "neutral" };
    case "summary_failed":
      return { rotulo: t("recent.summaryFailed"), tom: "danger" };
    case "transcription_failed":
      return { rotulo: t("recent.transcriptionFailed"), tom: "danger" };
    case "cancelled":
      return serverStates().cancelada;
    default: {
      // The `speakers` stage in `waiting` (contract 2.22.0) arrives here as an Awaiting speakers
      // alert with a link to the web. For an unknown state (from a newer server),
      // use its vocabulary label if available, otherwise the Needs you label.
      if (item.stage === "speakers" && item.detail === "waiting") return serverStates().aguardando_locutores;
      const known = serverStates()[item.detail]?.rotulo;
      return { rotulo: known ?? t("recent.needsYou"), tom: "warning" };
    }
  }
}

/** The detail line under a recording: the alert reason, the wait or nothing. */
export function detail(item, now = new Date()) {
  switch (item.phase) {
    case "upload_failed":
      return item.detail ?? t("recent.uploadFailed");
    case "queued":
      return waitPhrase(item.wait, now);
    case "no_summary":
      return item.reason ? reason(item.reason) : null;
    case "summary_failed":
      return t("recent.retrySummary");
    case "transcription_failed":
      return item.attention ? t("recent.seeReason") : t("recent.transientFailure");
    case "unknown": {
      const stage = item.stage ? `${stageName(item.stage)}: ` : "";
      const state = stepStates()[item.detail] ?? item.detail ?? "";
      const reasonText = item.reason ? ` · ${reason(item.reason)}` : "";
      return t("recent.resolveWeb", { stage, state, reason: reasonText });
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
  if (Number.isNaN(date.getTime())) return t("recent.recording");
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
            click: () => act(key, "copy_summary", { recordingId: item.remote_id }, "recent.summaryCopied"),
          },
        },
        copied ? t("recent.copied") : t("recent.copySummary"),
      );
      return button;
    }
    if (item.attention === "upload_failed") {
      return el(
        "button",
        { type: "button", class: "btn btn-ghost btn-sm", on: { click: () => act(key, "sync_now", undefined, "recent.uploading") } },
        t("recent.tryNow"),
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
        t("recent.openWeb"),
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
      el("progress", { class: "progress", max: 100, value: percent, "aria-label": t("recent.progress", { percent }) }),
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
      feedback && !feedback.error ? el("span", { class: "recent-detail", role: "status" }, t(feedback.message)) : null,
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
    empty.textContent = panel.error && !panel.fetched_at ? t("recent.noResponse") : t("recent.empty");
  }

  app.onLocaleChange(() => draw(last));

  return { draw };
}
