// Configurações em abas, como o DS mostra: Reuniões (detecção e política por app), Áudio
// (microfone, áudio do sistema, teste de nível, atalhos globais e parada por silêncio),
// Armazenamento (retenção, pasta local, espaço e "Tentar de novo as falhas") e Servidor. As
// abas salvam a cada mudança, menos o Servidor, que salva pelo botão.
import { el, trocar, $ } from "../dom.js";
import { teclas } from "./principal.js";

/** O subtítulo de cada app, como no frame "Settings · Meetings". */
const APPS = {
  teams: ["Microsoft Teams", "App ou aba do navegador"],
  zoom: ["Zoom", "App ou aba do navegador"],
  meet: ["Google Meet", "Aba do navegador"],
  webex: ["Webex", "App ou aba do navegador"],
  slack: ["Slack", "Chamadas"],
  navegador: ["Navegador", "Microfone em uso, reunião não reconhecida"],
  outro: ["Outro app", "Ditado, gravadores de voz, jogos"],
};

const POLITICAS = [
  ["auto", "Gravar"],
  ["ask", "Perguntar"],
  ["ignore", "Ignorar"],
];

/** A tecla principal de um `KeyboardEvent.code`, no formato do `global-hotkey`; `null` se não vale. */
function teclaDoCodigo(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return null;
}

/**
 * A combinação que o evento forma ("Ctrl+Alt+K", "Cmd+Shift+N"); `null` enquanto só há
 * modificadores ou a tecla não serve para atalho global.
 */
export function combinacao(evento) {
  const tecla = teclaDoCodigo(evento.code);
  if (!tecla) return null;
  const partes = [];
  if (evento.ctrlKey) partes.push("Ctrl");
  if (evento.altKey) partes.push("Alt");
  if (evento.shiftKey) partes.push("Shift");
  if (evento.metaKey) partes.push("Cmd");
  return [...partes, tecla].join("+");
}

/** "41 MB", "1,2 GB". */
export function tamanho(bytes) {
  const unidades = ["B", "KB", "MB", "GB", "TB"];
  let valor = bytes;
  let i = 0;
  while (valor >= 1000 && i < unidades.length - 1) {
    valor /= 1000;
    i += 1;
  }
  const casas = i >= 3 && valor < 10 ? 1 : 0;
  return `${valor.toLocaleString("pt-BR", { maximumFractionDigits: casas })} ${unidades[i]}`;
}

/** O que `save_settings` recebe, a partir do que `settings` devolveu e das mudanças. */
export function entrada(config, mudancas = {}) {
  return {
    web_url: config.web_url,
    api_url: config.api_url,
    ca_path: config.ca_path,
    detection_enabled: config.detection_enabled,
    policies: Object.fromEntries(config.apps.map((a) => [a.app, a.policy])),
    retention_days: config.retention_days,
    ...mudancas,
  };
}

export function montar(secao, app) {
  const abas = [...secao.querySelectorAll("[data-aba]")];
  const paineis = [...secao.querySelectorAll("[data-painel]")];
  const aviso = $("#config-aviso", secao);
  const dias = $("#retencao-dias", secao);
  const microfone = $("#microfone", secao);
  const barrasDoTeste = Array.from({ length: 16 }, () => el("i", { "data-quiet": true }));
  trocar($("#medidor-teste", secao), barrasDoTeste);
  let config = null;
  /** O atalho sendo capturado ("record", "note" ou "marker"). */
  let capturando = null;
  let consultaDoTeste = null;

  function mostrarAviso(texto, tom = "alert-error") {
    aviso.hidden = !texto;
    aviso.className = `alert ${tom}`;
    $("#config-aviso-texto", aviso).textContent = texto ?? "";
  }

  function abrirAba(nome) {
    for (const aba of abas) aba.setAttribute("aria-selected", String(aba.dataset.aba === nome));
    for (const painel of paineis) painel.hidden = painel.dataset.painel !== nome;
    mostrarAviso(null);
    if (nome === "armazenamento") lerArmazenamento();
    if (nome === "audio") lerMicrofones();
  }

  async function salvar(mudancas, sucesso) {
    try {
      config = await app.invoke("save_settings", { input: entrada(config, mudancas) });
      mostrarAviso(sucesso ?? null, "alert-success");
    } catch (falha) {
      mostrarAviso(String(falha));
    }
    desenhar();
    app.atualizar();
  }

  function linhaDoApp(item) {
    const [titulo, sub] = APPS[item.app] ?? [item.label, ""];
    const nome = `politica-${item.app}`;
    return el(
      "div",
      { class: "list-row", dataset: { app: item.app } },
      el("span", { class: "list-row-title" }, titulo),
      el("span", { class: "list-row-sub" }, sub),
      el(
        "span",
        { class: "list-row-actions" },
        el(
          "span",
          { class: "seg", role: "radiogroup", "aria-label": titulo },
          POLITICAS.map(([valor, rotulo]) =>
            el(
              "label",
              { class: "seg-opt" },
              el("input", {
                type: "radio",
                name: nome,
                value: valor,
                checked: item.policy === valor,
                on: { change: () => mudarPolitica(item.app, valor) },
              }),
              rotulo,
            ),
          ),
        ),
      ),
    );
  }

  function mudarPolitica(appKey, politica) {
    const policies = Object.fromEntries(config.apps.map((a) => [a.app, a.app === appKey ? politica : a.policy]));
    salvar({ policies });
  }

  function linhaDoAtalho(atalho) {
    const emCaptura = capturando === atalho.action;
    return el(
      "div",
      { class: "list-row", dataset: { atalho: atalho.action } },
      el("span", { class: "list-row-title" }, atalho.label),
      el(
        "span",
        { class: "list-row-sub", "data-problema": Boolean(atalho.problem) },
        atalho.problem ?? "Funciona com o eclume em segundo plano",
      ),
      el(
        "span",
        { class: "list-row-actions" },
        el(
          "kbd",
          { class: "code-block kbd-atalho", "data-capturando": emCaptura },
          emCaptura ? "Pressione a combinação…" : teclas(atalho.keys),
        ),
        el(
          "button",
          {
            type: "button",
            class: "btn btn-secondary btn-sm",
            on: { click: () => capturar(emCaptura ? null : atalho.action) },
          },
          emCaptura ? "Cancelar" : "Alterar",
        ),
      ),
    );
  }

  function capturar(acao) {
    capturando = acao;
    desenharAtalhos();
  }

  function desenharAtalhos() {
    trocar($("#atalhos", secao), (config?.shortcuts ?? []).map(linhaDoAtalho));
  }

  /** Captura a próxima combinação da janela antes das teclas da janela (Esc, Ctrl+O...). */
  function aoTeclar(evento) {
    if (!capturando) return;
    evento.preventDefault();
    evento.stopImmediatePropagation();
    if (evento.key === "Escape") {
      capturar(null);
      return;
    }
    const teclasNovas = combinacao(evento);
    if (!teclasNovas) return;
    if (!/\+/.test(teclasNovas)) {
      mostrarAviso("Use Ctrl, Alt, Shift ou ⌘ junto da tecla.");
      return;
    }
    const atuais = Object.fromEntries(config.shortcuts.map((a) => [a.action, a.keys]));
    const acao = capturando;
    capturando = null;
    salvar({ shortcuts: { ...atuais, [acao]: teclasNovas } });
  }

  async function lerMicrofones() {
    try {
      const lista = await app.invoke("list_input_devices");
      const escolhido = config?.mic ?? "";
      const opcoes = [el("option", { value: "" }, lista.default ? `Padrão do sistema · ${lista.default}` : "Padrão do sistema")];
      for (const nome of lista.names) opcoes.push(el("option", { value: nome }, nome));
      if (escolhido && !lista.names.includes(escolhido)) {
        opcoes.push(el("option", { value: escolhido }, `${escolhido} (desconectado)`));
      }
      trocar(microfone, opcoes);
      microfone.value = escolhido;
    } catch (falha) {
      mostrarAviso(String(falha));
    }
  }

  function desenharTeste(niveis) {
    niveis.forEach((nivel, i) => {
      barrasDoTeste[i].style.setProperty("--h", `${Math.round(Math.max(0.08, nivel) * 100)}%`);
      barrasDoTeste[i].toggleAttribute("data-quiet", nivel < 0.15);
    });
  }

  function pararTeste() {
    clearInterval(consultaDoTeste);
    consultaDoTeste = null;
    $("#testar-nivel", secao).textContent = "Fale para testar o nível";
    desenharTeste(barrasDoTeste.map(() => 0));
  }

  async function testarNivel() {
    try {
      await app.invoke("mic_test");
    } catch (falha) {
      mostrarAviso(String(falha));
      return;
    }
    $("#testar-nivel", secao).textContent = "Ouvindo…";
    clearInterval(consultaDoTeste);
    consultaDoTeste = setInterval(async () => {
      const niveis = await app.invoke("mic_test_meter").catch(() => null);
      if (niveis) desenharTeste(niveis);
      else pararTeste();
    }, 100);
  }

  function desenhar() {
    if (!config) return;
    $("#audio-sistema", secao).checked = config.system_audio;
    const silencio = String(config.note_silence_s ?? 0);
    for (const opcao of secao.querySelectorAll('input[name="silencio"]')) opcao.checked = opcao.value === silencio;
    desenharAtalhos();
    $("#detectar", secao).checked = config.detection_enabled;
    trocar($("#apps", secao), config.apps.map(linhaDoApp));

    const retencao = config.retention_days == null ? "sempre" : config.retention_days === 0 ? "apagar" : "dias";
    for (const opcao of secao.querySelectorAll('input[name="retencao"]')) opcao.checked = opcao.value === retencao;
    if (retencao === "dias") dias.value = String(config.retention_days);
    dias.disabled = retencao !== "dias";

    $("#servidor-endereco", secao).value = config.web_url;
    $("#servidor-api", secao).value = config.api_url ?? "";
    $("#servidor-ca", secao).value = config.ca_path ?? "";
    $("#servidor-token-estado", secao).textContent = config.pat_source
      ? "Conectado com um token pessoal."
      : "Sem token: as gravações ficam na fila até você colar um.";
    $("#servidor-esquecer", secao).hidden = !config.pat_source;
  }

  async function lerArmazenamento() {
    try {
      const info = await app.invoke("storage_info");
      $("#pasta-local", secao).textContent = info.dir;
      const n = info.recordings;
      $("#espaco-usado", secao).textContent = `${n === 1 ? "1 gravação" : `${n} gravações`} · ${tamanho(info.bytes)} neste computador`;
    } catch (falha) {
      mostrarAviso(String(falha));
    }
  }

  for (const aba of abas) aba.addEventListener("click", () => abrirAba(aba.dataset.aba));
  window.addEventListener("keydown", aoTeclar, true);
  microfone.addEventListener("change", () => salvar({ mic: microfone.value }));
  $("#audio-sistema", secao).addEventListener("change", (evento) => salvar({ system_audio: evento.target.checked }));
  for (const opcao of secao.querySelectorAll('input[name="silencio"]')) {
    opcao.addEventListener("change", () => salvar({ note_silence_s: Number(opcao.value) }));
  }
  $("#testar-nivel", secao).addEventListener("click", testarNivel);
  $("#config-voltar", secao).addEventListener("click", () => app.voltar());

  $("#detectar", secao).addEventListener("change", (evento) => salvar({ detection_enabled: evento.target.checked }));
  $("#restaurar-padroes", secao).addEventListener("click", (evento) => {
    evento.preventDefault();
    salvar({ policies: Object.fromEntries(config.apps.map((a) => [a.app, a.default_policy])) });
  });

  for (const opcao of secao.querySelectorAll('input[name="retencao"]')) {
    opcao.addEventListener("change", () => {
      const valor = { apagar: 0, sempre: null, dias: Number(dias.value) || 7 }[opcao.value];
      salvar({ retention_days: valor });
    });
  }
  dias.addEventListener("change", () => {
    const valor = Number(dias.value);
    if (!Number.isInteger(valor) || valor < 1 || valor > 3650) {
      mostrarAviso("Use de 1 a 3650 dias.");
      return;
    }
    salvar({ retention_days: valor });
  });
  $("#mostrar-pasta", secao).addEventListener("click", async () => {
    try {
      await app.invoke("open_data_dir");
    } catch (falha) {
      mostrarAviso(String(falha));
    }
  });
  $("#tentar-de-novo", secao).addEventListener("click", async () => {
    try {
      await app.invoke("sync_now");
      mostrarAviso("As falhas vão ser enviadas de novo.", "alert-success");
    } catch (falha) {
      mostrarAviso(String(falha));
    }
  });

  $("#servidor-salvar", secao).addEventListener("click", () => {
    const token = $("#servidor-token", secao).value.trim();
    salvar(
      {
        web_url: $("#servidor-endereco", secao).value.trim(),
        api_url: $("#servidor-api", secao).value.trim() || null,
        ca_path: $("#servidor-ca", secao).value.trim() || null,
        pat: token || null,
      },
      "Configurações do servidor salvas.",
    ).then(() => {
      $("#servidor-token", secao).value = "";
    });
  });
  $("#servidor-esquecer", secao).addEventListener("click", () => salvar({ clear_pat: true }, "Token esquecido."));

  return {
    sair() {
      capturando = null;
      if (consultaDoTeste) pararTeste();
    },

    async entrar(params) {
      try {
        config = await app.invoke("settings");
      } catch (falha) {
        mostrarAviso(String(falha));
      }
      desenhar();
      abrirAba(params?.aba ?? "reunioes");
    },
  };
}
