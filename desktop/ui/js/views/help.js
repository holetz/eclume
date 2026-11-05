// Desktop help (DS frame "Desktop help menu and shortcuts"): the menu anchored to the help
// icon on the home window and the Keyboard shortcuts sheet (Ctrl+/).
import { el, replace, $ } from "../dom.js";
import { version } from "../tauri.js";
import { MAC, keys } from "./home.js";

/** Window keys (global ones come from settings). */
const WINDOW_SHORTCUTS = [
  ["Importar arquivo", "O"],
  ["Configurações", ","],
  ["Atalhos de teclado", "/"],
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

  version().then((number) => {
    $("#help-version").textContent = `eclume ${number} · atualizado`;
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
  replace(
    $("#shortcuts-window", section),
    WINDOW_SHORTCUTS.map(([label, key]) => row(label, `${modifier}+${key}`)),
  );

  return {
    async enter() {
      try {
        const config = await app.invoke("settings");
        replace(
          $("#shortcuts-global", section),
          config.shortcuts.map((shortcut) => row(shortcut.label, shortcut.keys)),
        );
      } catch (failure) {
        console.error(failure);
      }
    },
  };
}
