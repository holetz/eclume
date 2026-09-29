// Configurações em abas, como o DS mostra: Reuniões (detecção e política por app), Áudio
// (microfone, áudio do sistema, teste de nível de cada fonte, atalhos globais e parada por silêncio),
// Armazenamento (retenção, pasta local, espaço e "Tentar de novo as falhas") e Servidor (a conta
// com "Sair", o endereço e, em "Avançado", a API e a CA extra). As abas salvam a cada mudança,
// menos o Servidor, que salva pelo botão.
import { el, trocar, $ } from "../dom.js";
import { teclas } from "./principal.js";
import { rotuloDoServidor } from "./primeira-execucao.js";

/** O subtítulo de cada app, como no frame "Settings · Meetings". */
const APPS = {
  teams: ["Microsoft Teams", "App ou aba do navegador"],
  zoom: ["Zoom", "App ou aba do navegador"],
  meet: ["Google Meet", "Aba do navegador"],
  webex: ["Webex", "App ou aba do navegador"],
  slack: ["Slack", "Chamadas"],
  whatsapp: ["WhatsApp", "App ou aba do WhatsApp Web"],
  navegador: ["Navegador", "Microfone em uso, reunião não reconhecida"],
  outro: ["Outro app", "Ditado, gravadores de voz, jogos"],
};

/** O rótulo do botão de teste de cada fonte, fora do teste (durante, é "Parar"). */
const TESTES = {
  mic: "Fale para testar",
  system: "Toque algo para testar",
};

/** "Nenhum" no microfone ou no áudio do sistema. */
const NENHUM = "none";

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

/**
 * A linha que explica como os atalhos chegam ao app nesta sessão; `null` no modo global, que é o
 * de sempre. `criados`: todos os atalhos do GNOME já existem.
 */
export function textoDoModo(modo, criados) {
  if (modo.mode === "portal") return "Pelo portal de atalhos do sistema. Se ele pedir, confirme as combinações.";
  if (modo.mode !== "system") return null;
  if (!modo.gnome) return "Nesta sessão (Wayland), crie no sistema um atalho para cada comando abaixo.";
  return criados
    ? "Nesta sessão (Wayland), os atalhos são do GNOME e chamam o eclume."
    : "Nesta sessão (Wayland), o eclume não ouve o teclado sozinho: crie os atalhos no GNOME.";
}

/** "Conectado · último envio 10:38", do resultado de `test_connection`. */
export function textoDaConexao(teste) {
  if (!teste.last_upload_at) return "Conectado · nenhum envio ainda";
  const hora = new Date(teste.last_upload_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `Conectado · último envio ${hora}`;
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
  const sistema = $("#audio-sistema", secao);
  const botoesDeTeste = [...secao.querySelectorAll("[data-fonte]")];
  const barrasDoTeste = Array.from({ length: 16 }, () => el("i", { "data-quiet": true }));
  trocar($("#medidor-teste", secao), barrasDoTeste);
  let config = null;
  /** A CA extra escolhida na aba Servidor, até salvar. */
  let caPath = null;
  /** O atalho sendo capturado ("record", "note" ou "marker"). */
  let capturando = null;
  let consultaDoTeste = null;
  /** A fonte em teste ("mic" ou "system"); `null` sem teste. */
  let testando = null;

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
    if (nome === "audio") {
      lerMicrofones();
      lerSaidas();
    }
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
    const modo = config?.shortcut_mode ?? { mode: "global" };
    const comando = modo.mode === "system" && !modo.gnome ? modo.commands.find((c) => c.action === atalho.action) : null;
    return el(
      "div",
      { class: "list-row", dataset: { atalho: atalho.action } },
      el("span", { class: "list-row-title" }, atalho.label),
      el(
        "span",
        { class: "list-row-sub", "data-problema": Boolean(atalho.problem) },
        atalho.problem ?? "Funciona com o eclume em segundo plano",
      ),
      comando ? el("code", { class: "code-block atalho-comando" }, comando.command) : null,
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
    const modo = config?.shortcut_mode ?? { mode: "global" };
    const atalhos = config?.shortcuts ?? [];
    const criados = atalhos.length > 0 && atalhos.every((a) => a.registration === "registered");
    const texto = textoDoModo(modo, criados);
    const linha = $("#atalhos-modo", secao);
    linha.hidden = !texto;
    linha.textContent = texto ?? "";
    const gnome = $("#atalhos-gnome", secao);
    gnome.hidden = !(modo.mode === "system" && modo.gnome);
    gnome.textContent = criados ? "Remover atalhos do GNOME" : "Criar atalhos no GNOME";
    gnome.dataset.criar = String(!criados);
    trocar($("#atalhos", secao), atalhos.map(linhaDoAtalho));
  }

  async function atalhosDoGnome() {
    const botao = $("#atalhos-gnome", secao);
    const criar = botao.dataset.criar === "true";
    botao.disabled = true;
    botao.textContent = criar ? "Criando atalhos…" : "Removendo atalhos…";
    try {
      config = await app.invoke("system_shortcuts", { install: criar });
      mostrarAviso(criar ? "Atalhos criados no GNOME." : "Atalhos removidos do GNOME.", "alert-success");
    } catch (falha) {
      mostrarAviso(String(falha));
    }
    botao.disabled = false;
    desenhar();
    aviso.scrollIntoView({ block: "nearest" });
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
      if (escolhido && escolhido !== NENHUM && !lista.names.includes(escolhido)) {
        opcoes.push(el("option", { value: escolhido }, `${escolhido} (desconectado)`));
      }
      opcoes.push(el("option", { value: NENHUM }, "Nenhum"));
      trocar(microfone, opcoes);
      microfone.value = escolhido;
    } catch (falha) {
      mostrarAviso(String(falha));
    }
  }

  async function lerSaidas() {
    try {
      const lista = await app.invoke("list_output_devices");
      const escolhido = config?.system_source ?? "follow";
      const ids = lista.devices.map((saida) => saida.id);
      const opcoes = [el("option", { value: "follow" }, "Seguir a saída em uso")];
      for (const saida of lista.devices) opcoes.push(el("option", { value: saida.id }, saida.name));
      if (escolhido !== "follow" && escolhido !== NENHUM && !ids.includes(escolhido)) {
        opcoes.push(el("option", { value: escolhido }, `${escolhido} (desconectada)`));
      }
      opcoes.push(el("option", { value: NENHUM }, "Nenhum"));
      trocar(sistema, opcoes);
      sistema.value = escolhido;
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

  /** Cada botão de teste: "Parar" na fonte em teste, desabilitado na fonte em "Nenhum". */
  function desenharBotoesDeTeste() {
    const desligada = { mic: config?.mic === NENHUM, system: config?.system_source === NENHUM };
    for (const botao of botoesDeTeste) {
      const fonte = botao.dataset.fonte;
      botao.textContent = testando === fonte ? "Parar" : TESTES[fonte];
      botao.disabled = desligada[fonte] && testando !== fonte;
    }
  }

  /** O teste acabou (sozinho ou parado): some o medidor e os botões voltam. */
  function pararTeste() {
    clearInterval(consultaDoTeste);
    consultaDoTeste = null;
    testando = null;
    desenharBotoesDeTeste();
    desenharTeste(barrasDoTeste.map(() => 0));
  }

  /** "Parar": encerra o teste no app, que larga o dispositivo na hora. */
  function encerrarTeste() {
    app.invoke("source_test_stop").catch(() => null);
    pararTeste();
  }

  async function testar(fonte) {
    if (testando === fonte) {
      encerrarTeste();
      return;
    }
    try {
      await app.invoke("source_test", { source: fonte });
    } catch (falha) {
      mostrarAviso(String(falha));
      return;
    }
    testando = fonte;
    desenharBotoesDeTeste();
    clearInterval(consultaDoTeste);
    consultaDoTeste = setInterval(async () => {
      const niveis = await app.invoke("source_test_meter").catch(() => null);
      if (!testando) return;
      if (niveis) desenharTeste(niveis);
      else pararTeste();
    }, 100);
  }

  function desenhar() {
    if (!config) return;
    // Uma escolha recusada (as duas fontes em "Nenhum") volta ao que está salvo.
    if (microfone.options.length) microfone.value = config.mic ?? "";
    if (sistema.options.length) sistema.value = config.system_source;
    desenharBotoesDeTeste();
    $("#idioma", secao).value = config.language ?? "";
    $("#avisar-resumo", secao).checked = config.notify_summary ?? true;
    const tema = config.theme ?? "system";
    for (const opcao of secao.querySelectorAll('input[name="tema"]')) opcao.checked = opcao.value === tema;
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
    caPath = config.ca_path ?? null;
    desenharCa();
    desenharConta();
  }

  function desenharCa() {
    $("#servidor-ca", secao).textContent = caPath ?? "Nenhuma";
    $("#servidor-ca-limpar", secao).hidden = !caPath;
  }

  function desenharConta() {
    const conta = config.account;
    const pessoal = config.connection === "personal_token";
    const servidor = rotuloDoServidor({ name: conta?.server_name, url: config.web_url });
    $("#servidor-conta", secao).textContent = conta
      ? conta.email
      : pessoal
        ? "Conectado com um token pessoal"
        : "Nenhuma conta neste computador";
    $("#servidor-conta-sub", secao).textContent = conta
      ? `Conectado ao ${servidor}`
      : pessoal
        ? "Entre com e-mail e senha para trocar o token pela conta"
        : "Entre para enviar as gravações";
    $("#servidor-entrar", secao).hidden = config.connection === "account";
    $("#servidor-sair", secao).hidden = config.connection === "first_run";
    $("#servidor-conexao", secao).hidden = true;
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
  // Trocar a fonte encerra o teste, que ouvia a escolha anterior.
  microfone.addEventListener("change", () => {
    if (testando) encerrarTeste();
    salvar({ mic: microfone.value });
  });
  sistema.addEventListener("change", () => {
    if (testando) encerrarTeste();
    salvar({ system_source: sistema.value });
  });
  $("#idioma", secao).addEventListener("change", (evento) => salvar({ language: evento.target.value }));
  $("#avisar-resumo", secao).addEventListener("change", (evento) =>
    salvar({ notify_summary: evento.target.checked }),
  );
  for (const opcao of secao.querySelectorAll('input[name="tema"]')) {
    opcao.addEventListener("change", () => {
      app.definirTema(opcao.value);
      salvar({ theme: opcao.value });
    });
  }
  for (const opcao of secao.querySelectorAll('input[name="silencio"]')) {
    opcao.addEventListener("change", () => salvar({ note_silence_s: Number(opcao.value) }));
  }
  for (const botao of botoesDeTeste) botao.addEventListener("click", () => testar(botao.dataset.fonte));
  $("#atalhos-gnome", secao).addEventListener("click", atalhosDoGnome);
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
    salvar(
      {
        web_url: $("#servidor-endereco", secao).value.trim(),
        api_url: $("#servidor-api", secao).value.trim() || null,
        ca_path: caPath,
      },
      "Configurações do servidor salvas.",
    );
  });
  $("#servidor-ca-escolher", secao).addEventListener("click", async () => {
    const escolhido = await app.invoke("pick_ca_file").catch((falha) => {
      mostrarAviso(String(falha));
      return null;
    });
    if (!escolhido) return;
    caPath = escolhido;
    desenharCa();
  });
  $("#servidor-ca-limpar", secao).addEventListener("click", () => {
    caPath = null;
    desenharCa();
  });
  $("#servidor-testar", secao).addEventListener("click", async () => {
    const linha = $("#servidor-conexao", secao);
    linha.hidden = false;
    linha.dataset.status = "syncing";
    linha.textContent = "Testando…";
    try {
      const teste = await app.invoke("test_connection");
      linha.dataset.status = "synced";
      linha.textContent = textoDaConexao(teste);
      mostrarAviso(null);
    } catch (falha) {
      linha.hidden = true;
      mostrarAviso(String(falha));
    }
  });
  $("#servidor-sair", secao).addEventListener("click", async () => {
    try {
      await app.invoke("sign_out");
    } catch (falha) {
      mostrarAviso(String(falha));
      return;
    }
    await app.atualizar();
  });
  $("#servidor-entrar", secao).addEventListener("click", () => app.ir("primeira-execucao"));

  return {
    sair() {
      capturando = null;
      if (testando) encerrarTeste();
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
