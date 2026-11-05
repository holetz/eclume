import { activeLocale, t } from "./i18n.js";
import * as portuguese from "./vocabulario.js";

function states(source, group) {
  return Object.fromEntries(Object.entries(source).map(([key, value]) =>
    [key, { ...value, rotulo: t(`vocabulary.${group}.${key}`) }]));
}

export function deviceStates() {
  return activeLocale() === "pt-BR" ? portuguese.ESTADOS_APARELHO : states(portuguese.ESTADOS_APARELHO, "device");
}

export function serverStates() {
  return activeLocale() === "pt-BR" ? portuguese.ESTADOS_SERVIDOR : states(portuguese.ESTADOS_SERVIDOR, "server");
}

export function steps() {
  return activeLocale() === "pt-BR" ? portuguese.ETAPAS : portuguese.ETAPAS.map(({ etapa }) => ({
    etapa, nome: t(`vocabulary.step.${etapa}`), andamento: t(`vocabulary.busy.${etapa}`),
  }));
}

function labels(source, group) {
  return Object.fromEntries(Object.keys(source).map(key => [key, t(`vocabulary.${group}.${key}`)]));
}

export function stepStates() {
  return activeLocale() === "pt-BR" ? portuguese.ESTADOS_ETAPA : labels(portuguese.ESTADOS_ETAPA, "stepState");
}

export function reasons() {
  return activeLocale() === "pt-BR" ? portuguese.MOTIVOS : labels(portuguese.MOTIVOS, "reason");
}

function instantLabel(iso, now) {
  const date = new Date(iso);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return time;
  const day = new Intl.DateTimeFormat(activeLocale(), { day: "2-digit", month: "2-digit" }).format(date);
  return t("vocabulary.queue.dayTime", { date: day, time });
}

function etaLabel(iso, now) {
  const minutes = Math.round((new Date(iso).getTime() - now.getTime()) / 60000);
  if (minutes < 1) return t("vocabulary.queue.lessThanMinute");
  if (minutes < 60) return t("vocabulary.queue.minutes", { minutes });
  const rest = minutes % 60;
  const hours = Math.floor(minutes / 60);
  return rest ? t("vocabulary.queue.hoursMinutes", { hours, minutes: rest }) : t("vocabulary.queue.hours", { hours });
}

export function waitingPhrase(queue, now = new Date()) {
  if (activeLocale() === "pt-BR") return portuguese.fraseDaEspera(queue, now);
  if (!queue) return null;
  const processor = queue.processor;
  if (processor && !processor.online) {
    return processor.offline_since
      ? t("vocabulary.queue.offlineSince", { time: instantLabel(processor.offline_since, now) })
      : t("vocabulary.queue.offline");
  }
  if (queue.reason === "account_turn") {
    const ahead = queue.account_ahead ?? 0;
    return ahead === 0 ? t("vocabulary.queue.accountNext") : t("vocabulary.queue.accountAhead", { count: ahead });
  }
  if (queue.reason === "quota_window") {
    return queue.resumes_at
      ? t("vocabulary.queue.quotaAt", { time: instantLabel(queue.resumes_at, now) })
      : t("vocabulary.queue.quotaLater");
  }
  const parts = [];
  if (queue.ahead != null) parts.push(t("vocabulary.queue.position", { position: queue.ahead + 1 }));
  if (queue.estimated_start_at) parts.push(t("vocabulary.queue.starts", { eta: etaLabel(queue.estimated_start_at, now) }));
  return parts.length > 0 ? parts.join(" · ") : t("vocabulary.queue.waiting");
}
