// Import a file (DS frame "Import file"): the file arrives via the dialog, a window drop
// or the tray item; the view shows its name, duration and recording date read from the
// file for the person to confirm or correct, and tracks conversion through to the upload queue.
import { $ } from "../dom.js";
import { timer } from "./home.js";
import { t } from "../i18n.js";

/** "2026-09-19T14:02" in local time, the `datetime-local` value. */
export function toInput(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The `.date-source` text by date origin. */
export function dateOrigin(origin) {
  return origin === "file_mtime"
    ? t("import.dateOrigin.fileMtime")
    : t("import.dateOrigin.metadata");
}

export function mount(section, app) {
  const file = $("#import-file", section);
  const date = $("#import-date", section);
  const confirm = $("#import-confirm", section);
  const progressText = $("#import-conversion", section);
  const error = $("#import-error", section);
  /** The probed file (`probe_import`) and the initial date field value. */
  let current = null;
  let initialDate = "";
  let converting = false;
  let errorTranslation = null;

  function showError(text, translation = null) {
    errorTranslation = translation;
    error.hidden = !text;
    $("#import-error-text", error).textContent = text ?? "";
  }

  function clear() {
    current = null;
    converting = false;
    file.hidden = true;
    progressText.hidden = true;
    confirm.disabled = false;
    showError(null);
  }

  async function open(path) {
    clear();
    try {
      const probed = await app.invoke("probe_import", { path: path });
      if (!probed.has_audio) {
        const vars = { name: probed.name };
        showError(t("import.noAudio", vars), { key: "import.noAudio", vars });
        return;
      }
      current = probed;
      const duration = probed.duration_ms == null ? "" : ` · ${timer(probed.duration_ms)}`;
      $("#import-name", section).textContent = `${probed.name}${duration}`;
      initialDate = toInput(probed.recorded_at);
      date.value = initialDate;
      $("#import-origin", section).textContent = dateOrigin(probed.date_origin);
      file.hidden = false;
    } catch (failure) {
      showError(String(failure));
    }
  }

  async function choose() {
    try {
      const path = await app.invoke("pick_import_file");
      if (path) await open(path);
    } catch (failure) {
      showError(String(failure));
    }
  }

  async function importView() {
    if (!current || !date.value) return;
    const changed = date.value !== initialDate;
    const recordedAt = changed ? new Date(date.value).getTime() : current.recorded_at;
    converting = true;
    confirm.disabled = true;
    progressText.hidden = false;
    showError(null);
    try {
      await app.invoke("import_file", {
        path: current.path,
        recordedAt,
        recordedAtSource: changed ? "user" : "file_metadata",
      });
    } catch (failure) {
      converting = false;
      confirm.disabled = false;
      progressText.hidden = true;
      showError(String(failure));
    }
  }

  function progress(fraction) {
    $("#import-progress", section).value = fraction;
    $("#import-percent", section).textContent = `${Math.round(fraction * 100)}%`;
  }

  $("#import-choose", section).addEventListener("click", (event) => {
    event.preventDefault();
    choose();
  });
  $("#import-target", section).addEventListener("click", (event) => {
    if (event.target.closest("a")) return;
    event.preventDefault();
    choose();
  });
  confirm.addEventListener("click", importView);
  $("#import-cancel", section).addEventListener("click", async () => {
    if (converting) await app.invoke("cancel_import").catch(() => {});
    clear();
    app.back();
  });
  $("#import-close", section).addEventListener("click", () => app.back());

  app.listen("import-progress", ({ payload }) => progress(payload));
  app.listen("import-finished", () => {
    if (!converting) return;
    clear();
    app.back();
    app.refresh();
  });
  app.listen("import-failed", ({ payload }) => {
    if (!converting) return;
    converting = false;
    confirm.disabled = false;
    progressText.hidden = true;
    showError(payload);
  });

  app.onLocaleChange(() => {
    if (current) $("#import-origin", section).textContent = dateOrigin(current.date_origin);
    if (errorTranslation) {
      showError(t(errorTranslation.key, errorTranslation.vars), errorTranslation);
    }
  });

  return {
    enter(params) {
      if (params?.path) open(params.path);
      else if (!converting) clear();
    },
  };
}
