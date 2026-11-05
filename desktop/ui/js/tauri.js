// The only contact point with Tauri. Read the global API (`withGlobalTauri`) on every call,
// rather than module load, so browser tests can inject the mock first.

export function invoke(command, args) {
  return window.__TAURI__.core.invoke(command, args);
}

export function listen(event, handler) {
  return window.__TAURI__.event.listen(event, handler);
}

/** The app version (`tauri.conf.json`). */
export function version() {
  return window.__TAURI__.app.getVersion();
}
