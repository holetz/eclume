// Desktop help (DS frame "Desktop help menu and shortcuts"): the menu anchored to the help
// icon on the home window and the Keyboard shortcuts sheet (Ctrl+/).
import { el, replace, $ } from "../dom.js";
import { version } from "../tauri.js";
import { MAC, keys } from "./home.js";
import { t } from "../i18n.js";

/** Window keys (global ones come from settings). */
const WINDOW_SHORTCUTS = [
  ["help.import", "O"],
  ["help.settings", ","],
  ["help.shortcuts", "/"],
];

/** A combination as separate keys: ["⌘", "⇧", "N"] or ["Ctrl", "Alt", "N"]. */
export function parts(shortcut, mac = MAC) {
  return mac ? [...keys(shortcut, true)] : shortcut.split("+");
}

function row(label, shortcut) {
  return el(
    "div",
    {},
    el("dt", {}, label),
    el(
      "dd",
      {},
      parts(shortcut).map((key) => el("span", { class: "kbd" }, key)),
    ),
  );
}

/** Wire up the home window’s help menu. */
export function wireMenu(app) {
  const button = $("#open-help");
  const menu = $("#menu-help");

  function open(yes) {
    menu.hidden = !yes;
    button.setAttribute("aria-expanded", String(yes));
    if (yes) menu.querySelector("[role=menuitem]")?.focus();
  }

  async function execute(command, args) {
    open(false);
    try {
      await app.invoke(command, args);
    } catch (failure) {
      console.error(failure);
    }
  }

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    open(menu.hidden);
  });
  document.addEventListener("click", (event) => {
    if (!menu.hidden && !menu.contains(event.target)) open(false);
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      open(false);
      button.focus();
    }
  });
  $("#help-first-steps").addEventListener("click", () => execute("open_help", { article: "first-recording" }));
  $("#help-permissions").addEventListener("click", () =>
    execute("open_help", { article: "microphone-permissions" }),
  );
  $("#help-folder").addEventListener("click", () => execute("open_help", { article: "synced-folder" }));
  $("#help-shortcuts").addEventListener("click", () => {
    open(false);
    app.go("shortcuts");
  });
  $("#help-center").addEventListener("click", () => execute("open_help", { article: null }));
  $("#help-problem").addEventListener("click", () => execute("open_log_dir"));
  $("#help-shortcuts-tecla").textContent = MAC ? "⌘/" : "Ctrl+/";

  let currentVersion = null;
  function drawVersion() {
    if (currentVersion != null) $("#help-version").textContent = t("help.version", { version: currentVersion });
  }
  app.onLocaleChange(drawVersion);
  version().then((number) => {
    currentVersion = number;
    drawVersion();
  });

  return { close: () => open(false) };
}

/** The Keyboard shortcuts sheet. */
export function mount(section, app) {
  $("#shortcuts-close", section).addEventListener("click", () => app.back());
  $("#shortcuts-change", section).addEventListener("click", (event) => {
    event.preventDefault();
    app.go("settings", { tab: "audio" });
  });
  const modifier = MAC ? "Cmd" : "Ctrl";
  let shortcuts = [];
  function drawShortcuts() {
    replace(
      $("#shortcuts-window", section),
      WINDOW_SHORTCUTS.map(([labelKey, key]) => row(t(labelKey), `${modifier}+${key}`)),
    );
    replace(
      $("#shortcuts-global", section),
      shortcuts.map((shortcut) => row(t(`help.shortcut.${shortcut.action}`), shortcut.keys)),
    );
  }
  drawShortcuts();
  app.onLocaleChange(drawShortcuts);

  return {
    async enter() {
      try {
        const config = await app.invoke("settings");
        shortcuts = config.shortcuts;
        drawShortcuts();
      } catch (failure) {
        console.error(failure);
      }
    },
  };
}
