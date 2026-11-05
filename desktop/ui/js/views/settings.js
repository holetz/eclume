// Tabbed settings, as in the DS: General (appearance, autostart and notifications), opened
// by default; Meetings (detection and per-app policy, including automatic stopping), Audio
// (microphone, system audio, per-source level test, global shortcuts and silence stop),
// Storage (retention, local folder, space and retrying failed uploads), Sync (the folder
// mirroring summaries and transcripts, its state and Sync now), and Server (the account
// with Sign out, the address and, under Advanced, the API and extra CA). Tabs save each change,
// except Server, which saves with a button.
import { el, replace, $ } from "../dom.js";
import { activeLocale, t } from "../i18n.js";
import { keys } from "./home.js";
import { serverLabel } from "./first-run.js";

/** Catalog keys use the app IDs returned by Rust. */
const APPS = new Set(["teams", "zoom", "meet", "webex", "slack", "whatsapp", "navegador", "outro"]);
const LANGUAGE_CODES = new Set(["auto", "pt", "es", "en"]);
const NONE = "none";
const POLICIES = ["auto", "ask", "ignore"];

/** The main key of a `KeyboardEvent.code`, in `global-hotkey` format; `null` if invalid. */
function keyFromCode(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return null;
}

/** The combination formed by the event ("Ctrl+Alt+K", "Cmd+Shift+N"); `null` while only
 * modifiers are pressed or the key is unsuitable for a global shortcut. */
export function combination(event) {
  const key = keyFromCode(event.code);
  if (!key) return null;
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Cmd");
  return [...parts, key].join("+");
}

/** The line explaining how shortcuts reach the app in this session; `null` in the usual
 * global mode. `created`: all GNOME shortcuts already exist. */
export function modeText(mode, created) {
  if (mode.mode === "portal") return t("settings.mode.portal");
  if (mode.mode !== "system") return null;
  if (!mode.gnome) return t("settings.mode.system");
  return created
    ? t("settings.mode.created")
    : t("settings.mode.create");
}

/** The connected status with last upload time, from the `test_connection` result. */
export function connectionText(result) {
  if (!result.last_upload_at) return t("settings.connection.empty");
  const time = new Date(result.last_upload_at).toLocaleTimeString(activeLocale(), { hour: "2-digit", minute: "2-digit" });
  return t("settings.connection.upload", { time });
}

/** "41 MB", "1,2 GB". */
export function size(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i += 1;
  }
  const decimals = i >= 3 && value < 10 ? 1 : 0;
  return `${value.toLocaleString(activeLocale(), { maximumFractionDigits: decimals })} ${units[i]}`;
}

/** The synced folder status line text, from the `mirror_status` result. */
export function folderText(config, state) {
  if (!config.mirror_enabled) return ["idle", t("settings.folder.off")];
  if (!config.mirror_dir) return ["idle", t("settings.folder.choose")];
  if (state?.running) return ["syncing", t("settings.folder.syncing")];
  if (state?.last_error) return ["away", state.last_error];
  if (!state?.last_sync_ms) return ["syncing", t("settings.folder.waiting")];
  const time = new Date(state.last_sync_ms).toLocaleTimeString(activeLocale(), { hour: "2-digit", minute: "2-digit" });
  const n = state.last?.recordings ?? 0;
  const loaded = t("settings.folder.recordings", { count: n });
  return ["synced", t("settings.folder.synced", { time, loaded })];
}

/** What `save_settings` receives, from the `settings` result and the changes. */
export function input(config, changes = {}) {
  return {
    web_url: config.web_url,
    api_url: config.api_url,
    ca_path: config.ca_path,
    detection_enabled: config.detection_enabled,
    policies: Object.fromEntries(config.apps.map((a) => [a.app, a.policy])),
    retention_days: config.retention_days,
    ...changes,
  };
}

export function mount(section, app) {
  const tabs = [...section.querySelectorAll("[data-tab]")];
  const panels = [...section.querySelectorAll("[data-panel]")];
  const notice = $("#config-notice", section);
  const days = $("#retention-days", section);
  const microphone = $("#microphone", section);
  const systemAudio = $("#audio-system", section);
  const testButtons = [...section.querySelectorAll("[data-source]")];
  const testBars = Array.from({ length: 16 }, () => el("i", { "data-quiet": true }));
  replace($("#meter-test", section), testBars);
  let config = null;
  /** The extra CA chosen in the Server tab, until saved. */
  let caPath = null;
  /** The shortcut being captured ("record", "note" or "marker"). */
  let capturing = null;
  let testPoll = null;
  /** The timer refreshing the synced folder state while its tab is open. */
  let folderPoll = null;
  /** The latest `mirror_status`, to redraw the tab without waiting for the next poll. */
  let folderState = null;
  /** The source under test ("mic" or "system"); `null` when idle. */
  let testing = null;

  function showNotice(text, tone = "alert-error") {
    notice.hidden = !text;
    notice.className = `alert ${tone}`;
    $("#config-notice-text", notice).textContent = text ?? "";
  }

  function openTab(name) {
    for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
    for (const panel of panels) panel.hidden = panel.dataset.panel !== name;
    drawLocale();
    showNotice(null);
    if (name !== "folder") stopFolderPoll();
    if (name === "storage") readStorage();
    if (name === "folder") readFolder();
    if (name === "audio") {
      readMicrophones();
      readOutputs();
      readAccountLanguage();
    }
  }

  /** Name the default using the actual account language (Account default: Portuguese). */
  async function readAccountLanguage() {
    const language = await app.invoke("account_language").catch(() => null);
    const code = language && (LANGUAGE_CODES.has(language) ? language : language.split("-")[0]);
    const name = language && (LANGUAGE_CODES.has(code) ? t(`settings.languages.${code}`) : language);
    $("#language-default", section).textContent = name ? t("settings.accountDefaultNamed", { name }) : t("settings.accountDefault");
  }

  async function save(changes, success) {
    try {
      config = await app.invoke("save_settings", { input: input(config, changes) });
      showNotice(success ?? null, "alert-success");
    } catch (failure) {
      showNotice(String(failure));
    }
    draw();
    app.refresh();
  }

  function appRow(item) {
    const title = APPS.has(item.app) ? t(`settings.apps.${item.app}.title`) : item.label;
    const sub = APPS.has(item.app) ? t(`settings.apps.${item.app}.subtitle`) : "";
    const name = `policy-${item.app}`;
    return el(
      "div",
      { class: "list-row", dataset: { app: item.app } },
      el("span", { class: "list-row-title" }, title),
      el("span", { class: "list-row-sub" }, sub),
      el(
        "span",
        { class: "list-row-actions" },
        el(
          "span",
          { class: "seg", role: "radiogroup", "aria-label": title },
          POLICIES.map((value) =>
            el(
              "label",
              { class: "seg-opt" },
              el("input", {
                type: "radio",
                name: name,
                value: value,
                checked: item.policy === value,
                on: { change: () => changePolicy(item.app, value) },
              }),
              t(`settings.policy.${value}`),
            ),
          ),
        ),
      ),
    );
  }

  function changePolicy(appKey, policy) {
    const policies = Object.fromEntries(config.apps.map((a) => [a.app, a.app === appKey ? policy : a.policy]));
    save({ policies });
  }

  function shortcutRow(shortcut) {
    const isCapturing = capturing === shortcut.action;
    const mode = config?.shortcut_mode ?? { mode: "global" };
    const command = mode.mode === "system" && !mode.gnome ? mode.commands.find((c) => c.action === shortcut.action) : null;
    const registration = ["in_use", "unavailable", "system"].includes(shortcut.registration)
      ? t(`settings.registration.${shortcut.registration}`) : shortcut.problem;
    return el(
      "div",
      { class: "list-row", dataset: { shortcut: shortcut.action } },
      el("span", { class: "list-row-title" }, t(`settings.shortcut.${shortcut.action}`)),
      el(
        "span",
        { class: "list-row-sub", "data-problem": Boolean(registration) },
        registration ?? t("settings.shortcutBackground"),
      ),
      command ? el("code", { class: "code-block shortcut-command" }, command.command) : null,
      el(
        "span",
        { class: "list-row-actions" },
        el(
          "kbd",
          { class: "code-block kbd-shortcut", "data-capturing": isCapturing },
          isCapturing ? t("settings.capture") : keys(shortcut.keys),
        ),
        el(
          "button",
          {
            type: "button",
            class: "btn btn-secondary btn-sm",
            on: { click: () => capture(isCapturing ? null : shortcut.action) },
          },
          isCapturing ? t("settings.cancel") : t("settings.change"),
        ),
      ),
    );
  }

  function capture(action) {
    capturing = action;
    drawShortcuts();
  }

  function drawShortcuts() {
    const mode = config?.shortcut_mode ?? { mode: "global" };
    const shortcuts = config?.shortcuts ?? [];
    const created = shortcuts.length > 0 && shortcuts.every((a) => a.registration === "registered");
    const text = modeText(mode, created);
    const row = $("#shortcuts-mode", section);
    row.hidden = !text;
    row.textContent = text ?? "";
    const gnome = $("#shortcuts-gnome", section);
    gnome.hidden = !(mode.mode === "system" && mode.gnome);
    gnome.textContent = created ? t("settings.gnome.remove") : t("settings.gnome.create");
    gnome.dataset.create = String(!created);
    replace($("#shortcuts", section), shortcuts.map(shortcutRow));
  }

  async function gnomeShortcuts() {
    const button = $("#shortcuts-gnome", section);
    const create = button.dataset.create === "true";
    button.disabled = true;
    button.textContent = create ? t("settings.gnome.creating") : t("settings.gnome.removing");
    try {
      config = await app.invoke("system_shortcuts", { install: create });
      showNotice(create ? t("settings.gnome.created") : t("settings.gnome.removed"), "alert-success");
    } catch (failure) {
      showNotice(String(failure));
    }
    button.disabled = false;
    draw();
    notice.scrollIntoView({ block: "nearest" });
  }

  /** Capture the next window combination before window keys (Esc, Ctrl+O...). */
  function onKeyDown(event) {
    if (!capturing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Escape") {
      capture(null);
      return;
    }
    const newKeys = combination(event);
    if (!newKeys) return;
    if (!/\+/.test(newKeys)) {
      showNotice(t("settings.modifierRequired"));
      return;
    }
    const currentSettings = Object.fromEntries(config.shortcuts.map((a) => [a.action, a.keys]));
    const action = capturing;
    capturing = null;
    save({ shortcuts: { ...currentSettings, [action]: newKeys } });
  }

  async function readMicrophones() {
    try {
      const list = await app.invoke("list_input_devices");
      const chosen = config?.mic ?? "";
      const options = [el("option", { value: "" }, list.default ? t("settings.systemDefaultNamed", { name: list.default }) : t("settings.systemDefault"))];
      for (const name of list.names) options.push(el("option", { value: name }, name));
      if (chosen && chosen !== NONE && !list.names.includes(chosen)) {
        options.push(el("option", { value: chosen }, t("settings.disconnectedMic", { name: chosen })));
      }
      options.push(el("option", { value: NONE }, t("settings.none")));
      replace(microphone, options);
      microphone.value = chosen;
    } catch (failure) {
      showNotice(String(failure));
    }
  }

  async function readOutputs() {
    try {
      const list = await app.invoke("list_output_devices");
      const chosen = config?.system_source ?? "follow";
      const ids = list.devices.map((output) => output.id);
      const options = [el("option", { value: "follow" }, t("settings.followOutput"))];
      for (const output of list.devices) options.push(el("option", { value: output.id }, output.name));
      if (chosen !== "follow" && chosen !== NONE && !ids.includes(chosen)) {
        options.push(el("option", { value: chosen }, t("settings.disconnectedOutput", { name: chosen })));
      }
      options.push(el("option", { value: NONE }, t("settings.none")));
      replace(systemAudio, options);
      systemAudio.value = chosen;
    } catch (failure) {
      showNotice(String(failure));
    }
  }

  function drawTest(levels) {
    levels.forEach((level, i) => {
      testBars[i].style.setProperty("--h", `${Math.round(Math.max(0.08, level) * 100)}%`);
      testBars[i].toggleAttribute("data-quiet", level < 0.15);
    });
  }

  /** Each test button: Stop on the source under test, disabled on a source set to None. */
  function drawTestButtons() {
    const disabled = { mic: config?.mic === NONE, system: config?.system_source === NONE };
    for (const button of testButtons) {
      const source = button.dataset.source;
      button.textContent = testing === source ? t("settings.stop") : t(`settings.test.${source}`);
      button.disabled = disabled[source] && testing !== source;
    }
  }

  /** The test ended (on its own or stopped): hide the meter and reset the buttons. */
  function stopTest() {
    clearInterval(testPoll);
    testPoll = null;
    testing = null;
    drawTestButtons();
    drawTest(testBars.map(() => 0));
  }

  /** Stop: end the test in the app, releasing the device immediately. */
  function endTest() {
    app.invoke("source_test_stop").catch(() => null);
    stopTest();
  }

  async function testSource(source) {
    if (testing === source) {
      endTest();
      return;
    }
    try {
      await app.invoke("source_test", { source: source });
    } catch (failure) {
      showNotice(String(failure));
      return;
    }
    testing = source;
    drawTestButtons();
    clearInterval(testPoll);
    testPoll = setInterval(async () => {
      const levels = await app.invoke("source_test_meter").catch(() => null);
      if (!testing) return;
      if (levels) drawTest(levels);
      else stopTest();
    }, 100);
  }

  function drawLocale() {
    for (const option of section.querySelectorAll('input[name="locale"]')) {
      option.checked = option.value === (app.state?.locale_choice ?? "");
    }
  }

  function draw() {
    drawLocale();
    if (!config) return;
    // A rejected choice (both sources set to None) reverts to the saved values.
    if (microphone.options.length) microphone.value = config.mic ?? "";
    if (systemAudio.options.length) systemAudio.value = config.system_source;
    drawTestButtons();
    $("#language", section).value = config.language ?? "";
    $("#notify-summary", section).checked = config.notify_summary ?? true;
    $("#recent-count", section).value = String(config.recent_count ?? 5);
    $("#recent-tray-count", section).value = String(config.tray_recent_count ?? 1);
    $("#start-with-the-system", section).checked = config.autostart ?? true;
    const theme = config.theme ?? "system";
    for (const option of section.querySelectorAll('input[name="theme"]')) option.checked = option.value === theme;
    const silence = String(config.note_silence_s ?? 0);
    for (const option of section.querySelectorAll('input[name="silence"]')) option.checked = option.value === silence;
    drawShortcuts();
    $("#detect", section).checked = config.detection_enabled;
    replace($("#apps", section), config.apps.map(appRow));

    const retention = config.retention_days == null ? "forever" : config.retention_days === 0 ? "delete" : "days";
    for (const option of section.querySelectorAll('input[name="retention"]')) option.checked = option.value === retention;
    if (retention === "days") days.value = String(config.retention_days);
    days.disabled = retention !== "days";

    drawFolder(folderState);
    $("#server-address", section).value = config.web_url;
    $("#server-api", section).value = config.api_url ?? "";
    caPath = config.ca_path ?? null;
    drawCa();
    drawAccount();
  }

  function drawCa() {
    $("#server-ca", section).textContent = caPath ?? t("settings.noneFemale");
    $("#server-ca-clear", section).hidden = !caPath;
  }

  function drawAccount() {
    const account = config.account;
    const personal = config.connection === "personal_token";
    const server = serverLabel({ name: account?.server_name, url: config.web_url });
    $("#server-account", section).textContent = account
      ? account.email
      : personal
        ? t("settings.account.personal")
        : t("settings.account.empty");
    $("#server-account-sub", section).textContent = account
      ? t("settings.account.connected", { server })
      : personal
        ? t("settings.account.replaceToken")
        : t("settings.account.signInHint");
    $("#server-sign-in", section).hidden = config.connection === "account";
    $("#server-sign-out", section).hidden = config.connection === "first_run";
    $("#server-connection", section).hidden = true;
  }

  /** Poll the synced folder state; repeat every 3 s while its tab is open. */
  async function readFolder() {
    try {
      folderState = await app.invoke("mirror_status");
      drawFolder(folderState);
    } catch (failure) {
      showNotice(String(failure));
    }
    if (folderPoll === null) folderPoll = setInterval(readFolder, 3000);
  }

  function stopFolderPoll() {
    clearInterval(folderPoll);
    folderPoll = null;
  }

  function drawFolder(state) {
    if (!config) return;
    $("#folder-enable", section).checked = config.mirror_enabled;
    $("#folder-transcripts", section).checked = config.mirror_transcripts;
    $("#folder-path", section).textContent = config.mirror_dir ?? t("settings.noneFemale");
    const [status, text] = folderText(config, state);
    const row = $("#folder-estado", section);
    row.dataset.status = status;
    row.textContent = text;
    $("#folder-now", section).disabled = !config.mirror_enabled || !config.mirror_dir || Boolean(state?.running);
  }

  async function readStorage() {
    try {
      const info = await app.invoke("storage_info");
      $("#folder-local", section).textContent = info.dir;
      const n = info.recordings;
      $("#space-used", section).textContent = t("settings.storageUsed", { count: n, size: size(info.bytes) });
    } catch (failure) {
      showNotice(String(failure));
    }
  }

  for (const tab of tabs) tab.addEventListener("click", () => openTab(tab.dataset.tab));
  window.addEventListener("keydown", onKeyDown, true);
  // Changing the source ends the test, which was listening to the previous choice.
  microphone.addEventListener("change", () => {
    if (testing) endTest();
    save({ mic: microphone.value });
  });
  systemAudio.addEventListener("change", () => {
    if (testing) endTest();
    save({ system_source: systemAudio.value });
  });
  $("#language", section).addEventListener("change", (event) => save({ language: event.target.value }));
  $("#start-with-the-system", section).addEventListener("change", (event) =>
    save({ autostart: event.target.checked }),
  );
  $("#notify-summary", section).addEventListener("change", (event) =>
    save({ notify_summary: event.target.checked }),
  );
  $("#recent-count", section).addEventListener("change", (event) =>
    save({ recent_count: Number(event.target.value) }),
  );
  $("#recent-tray-count", section).addEventListener("change", (event) =>
    save({ tray_recent_count: Number(event.target.value) }),
  );
  for (const option of section.querySelectorAll('input[name="locale"]')) {
    option.addEventListener("change", async () => {
      try {
        await app.invoke("set_locale", { choice: option.value || null });
        await app.refresh();
      } catch (failure) {
        console.error(failure);
        drawLocale();
      }
    });
  }
  for (const option of section.querySelectorAll('input[name="theme"]')) {
    option.addEventListener("change", () => {
      app.setTheme(option.value);
      save({ theme: option.value });
    });
  }
  for (const option of section.querySelectorAll('input[name="silence"]')) {
    option.addEventListener("change", () => save({ note_silence_s: Number(option.value) }));
  }
  for (const button of testButtons) button.addEventListener("click", () => testSource(button.dataset.source));
  $("#shortcuts-gnome", section).addEventListener("click", gnomeShortcuts);
  $("#config-back", section).addEventListener("click", () => app.back());

  $("#detect", section).addEventListener("change", (event) => save({ detection_enabled: event.target.checked }));
  $("#restore-defaults", section).addEventListener("click", (event) => {
    event.preventDefault();
    save({ policies: Object.fromEntries(config.apps.map((a) => [a.app, a.default_policy])) });
  });

  for (const option of section.querySelectorAll('input[name="retention"]')) {
    option.addEventListener("change", () => {
      const value = { delete: 0, forever: null, days: Number(days.value) || 7 }[option.value];
      save({ retention_days: value });
    });
  }
  days.addEventListener("change", () => {
    const value = Number(days.value);
    if (!Number.isInteger(value) || value < 1 || value > 3650) {
      showNotice(t("settings.invalidDays"));
      return;
    }
    save({ retention_days: value });
  });
  $("#show-folder", section).addEventListener("click", async () => {
    try {
      await app.invoke("open_data_dir");
    } catch (failure) {
      showNotice(String(failure));
    }
  });
  $("#retry", section).addEventListener("click", async () => {
    try {
      await app.invoke("sync_now");
      showNotice(t("settings.retrySuccess"), "alert-success");
    } catch (failure) {
      showNotice(String(failure));
    }
  });

  $("#folder-enable", section).addEventListener("change", (event) => {
    save({ mirror_enabled: event.target.checked }).then(readFolder);
  });
  $("#folder-transcripts", section).addEventListener("change", (event) => {
    save({ mirror_transcripts: event.target.checked }).then(readFolder);
  });
  $("#folder-choose", section).addEventListener("click", async () => {
    const selected = await app.invoke("pick_mirror_dir").catch((failure) => {
      showNotice(String(failure));
      return null;
    });
    if (!selected) return;
    await save({ mirror_dir: selected });
    readFolder();
  });
  $("#folder-now", section).addEventListener("click", async () => {
    try {
      await app.invoke("mirror_sync_now");
    } catch (failure) {
      showNotice(String(failure));
      return;
    }
    readFolder();
  });
  $("#folder-help", section).addEventListener("click", (event) => {
    event.preventDefault();
    app.invoke("open_help", { article: "synced-folder" }).catch((failure) => showNotice(String(failure)));
  });

  $("#server-save", section).addEventListener("click", () => {
    save(
      {
        web_url: $("#server-address", section).value.trim(),
        api_url: $("#server-api", section).value.trim() || null,
        ca_path: caPath,
      },
      t("settings.serverSaved"),
    );
  });
  $("#server-ca-choose", section).addEventListener("click", async () => {
    const chosen = await app.invoke("pick_ca_file").catch((failure) => {
      showNotice(String(failure));
      return null;
    });
    if (!chosen) return;
    caPath = chosen;
    drawCa();
  });
  $("#server-ca-clear", section).addEventListener("click", () => {
    caPath = null;
    drawCa();
  });
  $("#server-test", section).addEventListener("click", async () => {
    const row = $("#server-connection", section);
    row.hidden = false;
    row.dataset.status = "syncing";
    row.textContent = t("settings.testing");
    try {
      const result = await app.invoke("test_connection");
      row.dataset.status = "synced";
      row.textContent = connectionText(result);
      showNotice(null);
    } catch (failure) {
      row.hidden = true;
      showNotice(String(failure));
    }
  });
  $("#server-sign-out", section).addEventListener("click", async () => {
    try {
      await app.invoke("sign_out");
    } catch (failure) {
      showNotice(String(failure));
      return;
    }
    await app.refresh();
  });
  $("#server-sign-in", section).addEventListener("click", () => app.go("first-run"));

  app.onLocaleChange(() => {
    draw();
    const activeTab = tabs.find((tab) => tab.getAttribute("aria-selected") === "true")?.dataset.tab;
    if (activeTab === "audio") {
      readMicrophones();
      readOutputs();
      readAccountLanguage();
    }
    if (activeTab === "storage") readStorage();
  });

  return {
    refresh() {
      drawLocale();
    },
    leave() {
      capturing = null;
      stopFolderPoll();
      if (testing) endTest();
    },

    async enter(params) {
      try {
        config = await app.invoke("settings");
      } catch (failure) {
        showNotice(String(failure));
      }
      draw();
      openTab(params?.tab ?? "general");
    },
  };
}
