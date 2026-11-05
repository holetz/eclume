// Desktop app window: route views (one <section data-view> each), apply the theme (from
// settings or the system), handle window keys and poll the Rust state
// once a second.
import { invoke, listen } from "./tauri.js";
import { fillIcons } from "./icons.js";
import * as home from "./views/home.js";
import * as firstRun from "./views/first-run.js";
import * as importView from "./views/import.js";
import * as settings from "./views/settings.js";
import * as help from "./views/help.js";

/** Registered views: name → { enter?(params), leave?(), refresh?(state) }. */
const views = new Map();
let current = null;

/** What views receive when mounted. */
const app = {
  invoke,
  listen,
  /** The latest state snapshot (`status`), queue (`recordings`) and Recent panel (`recent`). */
  state: null,
  queue: [],
  recent: null,
  go,
  back: () => go("home"),
  importFile,
  refresh,
  setTheme,
};

/** "system", "light" or "dark"; "system" follows `prefers-color-scheme`. */
let themePreference = "system";

/** Register a view whose section is already in HTML: `module.mount(section, app)` returns it. */
function register(name, module) {
  views.set(name, module.mount(document.querySelector(`[data-view="${name}"]`), app));
}

/** Show the view `name`; return `false` if it does not exist. */
function go(name, params) {
  const view = views.get(name);
  if (!view) return false;
  if (current && current !== name) views.get(current).leave?.();
  helpMenu?.close();
  for (const other of document.querySelectorAll("[data-view]")) other.hidden = other.dataset.view !== name;
  current = name;
  view.enter?.(params);
  if (app.state) view.refresh?.(app.state, app.queue);
  return true;
}

async function refresh() {
  try {
    // A panel failure does not prevent the rest of the window from rendering.
    const [state, queue, recent] = await Promise.all([
      invoke("status"),
      invoke("recordings", { limit: 50 }),
      invoke("recent").catch((failure) => {
        console.error(failure);
        return app.recent;
      }),
    ]);
    app.state = state;
    app.queue = queue;
    app.recent = recent;
    if (state.theme && state.theme !== themePreference) setTheme(state.theme);
    // Without a credential (or after the server CA changes), stay on first run.
    if (state.connection === "first_run" && current !== "first-run") go("first-run");
    else views.get(current)?.refresh?.(state, queue);
  } catch (error) {
    console.error(error);
  }
}

/** The DS only shows dark under `data-theme="dark"`: System also sets the attribute. */
function applyTheme() {
  const dark = themePreference === "system" ? darkTheme.matches : themePreference === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

function setTheme(preference) {
  themePreference = preference;
  applyTheme();
}

/** Window keys; Rust handles global shortcuts. */
function onKeyDown(event) {
  if (app.state?.connection === "first_run") return;
  if (event.key === "Escape") {
    if (current !== "home" && go("home")) event.preventDefault();
    return;
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "o") {
    event.preventDefault();
    importFile();
    return;
  }
  const destination = { ",": "settings", "/": "shortcuts" }[key];
  if (destination && go(destination)) event.preventDefault();
}

/** Import file: the system file picker, then the import view once a file is chosen. */
async function importFile() {
  try {
    const path = await invoke("pick_import_file");
    if (path) go("import", { path: path });
  } catch (error) {
    console.error(error);
  }
}

register("home", home);
register("first-run", firstRun);
register("import", importView);
register("settings", settings);
register("shortcuts", help);
const helpMenu = help.wireMenu(app);

const darkTheme = window.matchMedia("(prefers-color-scheme: dark)");
applyTheme();
darkTheme.addEventListener("change", applyTheme);
fillIcons();
document.addEventListener("keydown", onKeyDown);
go("home");
listen("status-changed", refresh);
// File dropped onto the window or chosen from the tray.
listen("import-dropped", ({ payload }) => go("import", { path: payload }));
setInterval(() => {
  if (!document.hidden) refresh();
}, 1000);
refresh();
