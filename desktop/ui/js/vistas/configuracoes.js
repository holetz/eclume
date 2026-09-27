// Configurações em abas, como o DS mostra: Reuniões (detecção e política por app), Armazenamento
// (retenção, pasta local, espaço e "Tentar de novo as falhas") e Servidor. Reuniões e
// Armazenamento salvam a cada mudança; o Servidor salva pelo botão.
import { el, trocar, $ } from "../dom.js";

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
  let config = null;

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

  function desenhar() {
    if (!config) return;
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
