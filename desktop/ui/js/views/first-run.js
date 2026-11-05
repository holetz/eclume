// First run (DS variant A, frame "First run"): the server the app already knows — from the
// installer, discovered on the network or typed under Advanced —, the CA pinned by fingerprint
// (or checked by the person when the address came without one), and sign-in by email and password
// or pairing code.
import { el, replace, $ } from "../dom.js";
import { t } from "../i18n.js";

const ORIGINS = {
  installer: "firstRun.origins.installer",
  network: "firstRun.origins.network",
  typed: "firstRun.origins.typed",
};

/** The server name and address host, as in the eclume server label. */
export function serverLabel(server) {
  let host = server.url;
  try {
    host = new URL(server.url).hostname;
  } catch {
    // Malformed address: display it as received.
  }
  const name = server.name && server.name !== host ? server.name : "eclume";
  return t("firstRun.serverLabel", { name, host });
}

/** The typed address, adding https for a bare host; `null` if invalid. */
export function typedAddress(text) {
  const trimmed = text.trim().replace(/\/+$/, "");
  const url = /^https?:\/\//.test(trimmed) ? trimmed : `https:\/\/${trimmed}`;
  return /^https?:\/\/[^\s/]+$/.test(url) ? url : null;
}

/** The fingerprint in hex pairs separated by ":", for visual checking. */
export function readableFingerprint(hex) {
  return (hex ?? "").toUpperCase().match(/.{1,2}/g)?.join(":") ?? "";
}

export function mount(section, app) {
  const list = $("#first-run-servers", section);
  const notice = $("#first-run-notice", section);
  const trust = $("#first-run-trust", section);
  const advanced = $("#first-run-advanced", section);
  const buttons = [$("#first-run-sign-in", section), $("#first-run-pair", section)];
  let servers = [];
  let chosen = null;
  /** The server prepared by Rust (CA pinned), or `null`. */
  let prepared = null;
  /** The person has checked the fingerprint for an address without one (TOFU). */
  let trusted = false;
  let busy = false;
  /** The latest choice: discard a late response from an earlier choice. */
  let request = 0;
  let noticeKey = null;

  function showNotice(text, key = null) {
    noticeKey = key;
    notice.hidden = !text;
    $("#first-run-notice-text", notice).textContent = text ?? "";
  }

  function showSearching(key) {
    const searching = $("#first-run-searching", section);
    searching.dataset.i18n = key;
    searching.textContent = t(key);
    searching.hidden = false;
  }

  function canSignIn() {
    return Boolean(prepared) && (prepared.trusted_by !== "first_use" || trusted) && !busy;
  }

  function drawButtons() {
    for (const button of buttons) button.disabled = !canSignIn();
  }

  function drawServers() {
    replace(
      list,
      servers.map((server) =>
        el(
          "label",
          { class: "choice", dataset: { url: server.url } },
          el("input", {
            type: "radio",
            name: "server",
            value: server.url,
            checked: chosen?.url === server.url,
            on: { change: () => choose(server) },
          }),
          el("span", { class: "dot" }),
          el("strong", {}, serverLabel(server)),
          el(
            "small",
            {},
            ORIGINS[server.origin] ? t(ORIGINS[server.origin]) : "",
            " · ",
            el("a", { href: "#", on: { click: useAnother } }, t("firstRun.useAnother")),
          ),
        ),
      ),
    );
  }

  function useAnother(event) {
    event.preventDefault();
    advanced.open = true;
    $("#first-run-address", section).focus();
  }

  function drawTrust() {
    const verify = prepared?.trusted_by === "first_use" && !trusted;
    trust.hidden = !verify;
    if (verify) {
      $("#first-run-trust-server", trust).textContent = serverLabel(prepared);
      $("#first-run-fingerprint", trust).textContent = readableFingerprint(prepared.ca_sha256);
    }
    drawButtons();
  }

  async function choose(server) {
    const thisRequest = ++request;
    chosen = server;
    prepared = null;
    trusted = false;
    drawServers();
    $("#first-run-searching", section).hidden = true;
    drawTrust();
    showNotice(null);
    try {
      const ready = await app.invoke("prepare_server", { url: server.url, caSha256: server.ca_sha256 ?? null });
      if (thisRequest !== request) return;
      prepared = ready;
    } catch (failure) {
      if (thisRequest !== request) return;
      showNotice(String(failure));
    }
    drawTrust();
  }

  async function discover() {
    showSearching("firstRun.searching");
    try {
      servers = await app.invoke("discover_servers");
    } catch (failure) {
      servers = [];
      showNotice(String(failure));
    }
    if (chosen?.origin === "typed" && !servers.some((s) => s.url === chosen.url)) servers.push(chosen);
    if (servers.length === 0) {
      showSearching("firstRun.noServers");
      advanced.open = true;
      return;
    }
    drawServers();
    await choose(servers.find((s) => s.url === chosen?.url) ?? servers[0]);
  }

  async function signInWith(command, args) {
    if (!canSignIn()) return;
    busy = true;
    drawButtons();
    showNotice(null);
    try {
      await app.invoke(command, args);
      $("#first-run-password", section).value = "";
      $("#first-run-code", section).value = "";
      await app.refresh();
      app.back();
    } catch (failure) {
      showNotice(String(failure));
    } finally {
      busy = false;
      drawButtons();
    }
  }

  $("#first-run-sign-in-form", section).addEventListener("submit", (event) => {
    event.preventDefault();
    signInWith("sign_in", { email: $("#first-run-email", section).value.trim(), password: $("#first-run-password", section).value });
  });
  $("#first-run-pair", section).addEventListener("click", () => {
    const code = $("#first-run-code", section).value.trim();
    if (!code) {
      showNotice(t("firstRun.missingCode"), "firstRun.missingCode");
      return;
    }
    signInWith("pair", { code: code });
  });
  $("#first-run-trust-continue", section).addEventListener("click", async () => {
    if (!prepared) return;
    try {
      await app.invoke("confirm_server", { url: prepared.url, caSha256: prepared.ca_sha256 ?? null });
      trusted = true;
    } catch (failure) {
      showNotice(String(failure));
    }
    drawTrust();
  });
  $("#first-run-use-address", section).addEventListener("click", () => {
    const url = typedAddress($("#first-run-address", section).value);
    if (!url) {
      showNotice(t("firstRun.invalidAddress"), "firstRun.invalidAddress");
      return;
    }
    const typed = { name: "", url, ca_sha256: null, origin: "typed" };
    servers = [...servers.filter((s) => s.url !== url), typed];
    choose(typed);
  });
  $("#first-run-search", section).addEventListener("click", (event) => {
    event.preventDefault();
    discover();
  });
  $("#first-run-signup", section).addEventListener("click", async (event) => {
    event.preventDefault();
    const url = prepared?.url ?? chosen?.url;
    if (!url) {
      showNotice(t("firstRun.chooseServer"), "firstRun.chooseServer");
      return;
    }
    try {
      await app.invoke("open_signup", { url });
    } catch (failure) {
      showNotice(String(failure));
    }
  });
  $("#first-run-back", section).addEventListener("click", () => app.back());

  app.onLocaleChange(() => {
    drawServers();
    drawTrust();
    if (noticeKey) showNotice(t(noticeKey), noticeKey);
  });

  return {
    enter() {
      showNotice(null);
      drawButtons();
      discover();
    },

    refresh(state) {
      // People already syncing (legacy PAT) arrive via email and password sign-in and can go back.
      $("#first-run-back", section).hidden = state.connection === "first_run";
      if (state.connection === "first_run" && state.sync_notice && notice.hidden) {
        showNotice(state.sync_notice);
      }
    },
  };
}
