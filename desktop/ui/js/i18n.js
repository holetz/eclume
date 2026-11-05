import en from "./locales/en.js";
import ptBR from "./locales/pt-BR.js";

export const LOCALES = ["en", "pt-BR"];
export const DEFAULT_LOCALE = "en";
const catalogs = { en, "pt-BR": ptBR };
const STORAGE_KEY = "eclume-locale";
const listeners = new Set();
let locale = null;

export function normalize(tag) {
  const language = tag?.trim().replaceAll("_", "-").split("-")[0].toLowerCase();
  if (language === "pt") return "pt-BR";
  if (language === "en") return "en";
  return null;
}

export function activeLocale() {
  return locale ?? DEFAULT_LOCALE;
}

function lookup(catalog, key, vars) {
  let value = key.split(".").reduce((node, part) =>
    node && Object.hasOwn(node, part) ? node[part] : undefined, catalog);
  if (value && typeof value === "object" && typeof vars.count === "number") {
    const form = vars.count === 0 && Object.hasOwn(value, "zero")
      ? "zero" : new Intl.PluralRules(activeLocale()).select(vars.count);
    value = value[form] ?? value.other;
  }
  return typeof value === "string" ? value : undefined;
}

export function t(key, vars = {}) {
  const value = lookup(catalogs[activeLocale()], key, vars) ?? lookup(en, key, vars) ?? key;
  return value.replace(/\{([^{}]+)\}/g, (placeholder, name) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : placeholder);
}

export function applyStatic(root) {
  const bindings = [
    ["data-i18n", null],
    ...["aria-label", "title", "placeholder", "alt"].map(attribute => [`data-i18n-${attribute}`, attribute]),
  ];
  for (const [binding, attribute] of bindings) {
    const elements = [...root.querySelectorAll(`[${binding}]`)];
    if (root.matches?.(`[${binding}]`)) elements.unshift(root);
    for (const element of elements) {
      const value = t(element.getAttribute(binding));
      if (attribute) element.setAttribute(attribute, value);
      else element.textContent = value;
    }
  }
}

export function setLocale(next) {
  next = normalize(next) ?? DEFAULT_LOCALE;
  if (locale === next) return;
  locale = next;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Storage blocked: the next visit starts from the browser language.
  }
  document.documentElement.lang = locale;
  applyStatic(document);
  for (const listener of listeners) listener(locale);
}

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function startLocale() {
  try {
    const stored = normalize(localStorage.getItem(STORAGE_KEY));
    if (stored) return stored;
  } catch {
    // Storage may be blocked by the webview.
  }
  for (const language of navigator.languages ?? [navigator.language]) {
    const normalized = normalize(language);
    if (normalized) return normalized;
  }
  return DEFAULT_LOCALE;
}

/** The first supported OS language, as `startLocale` picks it; else the first one, unsupported. */
export function systemTag() {
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language ?? ""];
  return languages.find((language) => normalize(language)) ?? languages[0] ?? "";
}
