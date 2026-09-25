// Janela de status, fila e configurações do app desktop do eclume. Sem bundler: usa a API global
// do Tauri.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const ROTULOS = { idle: "Ocioso", recording: "Gravando", syncing: "Sincronizando" };
const SITUACOES = {
  recording: "gravando",
  pending: "a sincronizar",
  syncing: "sincronizando",
  synced: "sincronizada",
  failed: "falhou",
};
const APPS_DE_REUNIAO = { teams: "Teams", meet: "Meet", zoom: "Zoom" };
const POLITICAS = [
  ["auto", "Gravar automaticamente"],
  ["ask", "Perguntar"],
  ["ignore", "Ignorar"],
];
const ORIGENS_PAT = {
  keyring: "PAT configurado, guardado no chaveiro do sistema.",
  file: "PAT configurado, guardado num arquivo só seu (o chaveiro do sistema não está disponível).",
  env: "PAT definido pela variável ECLUME_PAT.",
};

function duracao(ms) {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}:${r}`;
}

function tamanho(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const quando = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

function mostrar(id, texto) {
  const el = $(id);
  el.textContent = texto || "";
  el.hidden = !texto;
}

function desenharStatus(view) {
  const estado = $("estado");
  estado.dataset.status = view.status;
  let texto = ROTULOS[view.status];
  if (view.status === "recording") {
    if (view.recording_started_at) texto = `Gravando há ${duracao(Date.now() - view.recording_started_at)}`;
    if (view.recording_app) texto += ` · ${view.recording_app.label}`;
    if (view.recording_auto) texto += " (automático)";
  } else if (view.meeting) {
    texto += ` · reunião no ${view.meeting.label}`;
  }
  estado.textContent = texto;

  const alternar = $("alternar");
  const gravando = view.status === "recording";
  alternar.dataset.recording = String(gravando);
  alternar.textContent = gravando ? "Parar gravação" : "Iniciar gravação";

  const pergunta = $("pergunta");
  pergunta.hidden = !view.pending_ask;
  if (view.pending_ask) {
    $("pergunta-texto").textContent = `Reunião no ${view.pending_ask.label} detectada. Gravar?`;
  }

  const faltam = view.counts.pending + view.counts.syncing + view.counts.failed;
  $("resumo").textContent = faltam === 0 ? "" : `${faltam} a sincronizar`;
  mostrar("aviso", view.notice);
  mostrar("aviso-sync", view.sync_notice);
}

function desenharFila(gravacoes) {
  const fila = $("fila");
  fila.replaceChildren(
    ...gravacoes.map((g) => {
      const li = document.createElement("li");
      const titulo = document.createElement("span");
      titulo.className = "quando";
      titulo.textContent = quando.format(new Date(g.started_at));
      const situacao = document.createElement("span");
      situacao.className = "situacao";
      situacao.dataset.status = g.status;
      situacao.textContent = SITUACOES[g.status] ?? g.status;
      if (g.last_error) situacao.title = g.last_error;
      const detalhe = document.createElement("span");
      detalhe.className = "detalhe";
      detalhe.textContent = [
        duracao(g.duration_ms),
        tamanho(g.bytes),
        APPS_DE_REUNIAO[g.meeting_app] ?? "",
        g.interrupted ? "interrompida" : "",
        g.purged_at ? "arquivo local removido" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      li.append(titulo, situacao, detalhe);
      return li;
    }),
  );
  $("vazio").hidden = gravacoes.length > 0;
}

async function atualizar() {
  try {
    const [view, gravacoes] = await Promise.all([invoke("status"), invoke("recordings", { limit: 50 })]);
    desenharStatus(view);
    desenharFila(gravacoes);
  } catch (erro) {
    mostrar("aviso", String(erro));
  }
}

function desenharConfig(config) {
  $("web-url").value = config.web_url;
  $("api-url").value = config.api_url ?? "";
  $("ca-path").value = config.ca_path ?? "";
  $("pat").value = "";
  $("pat").placeholder = config.pat_source ? "•••••••• (digite para trocar)" : "eclp_…";
  $("pat-origem").textContent = ORIGENS_PAT[config.pat_source]
    ?? "Sem PAT: crie um no eclume web com o escopo recordings:write e cole aqui.";
  $("esquecer-pat").hidden = !config.pat_source || config.pat_source === "env";
  $("deteccao").checked = config.detection_enabled;

  const corpo = $("politicas").tBodies[0];
  corpo.replaceChildren(
    ...config.apps.map(({ app, label, policy }) => {
      const tr = document.createElement("tr");
      const nome = document.createElement("td");
      nome.textContent = label;
      const celula = document.createElement("td");
      const select = document.createElement("select");
      select.dataset.app = app;
      select.setAttribute("aria-label", `Política para ${label}`);
      for (const [valor, rotulo] of POLITICAS) select.add(new Option(rotulo, valor, false, valor === policy));
      celula.append(select);
      tr.append(nome, celula);
      return tr;
    }),
  );

  const retencao = $("retencao");
  const valor = config.retention_days == null ? "sempre" : String(config.retention_days);
  if (![...retencao.options].some((o) => o.value === valor)) {
    retencao.add(new Option(`Manter por ${valor} dias`, valor));
  }
  retencao.value = valor;
}

async function carregarConfig() {
  try {
    desenharConfig(await invoke("settings"));
  } catch (erro) {
    $("config-status").textContent = String(erro);
  }
}

function lerConfig(esquecerPat) {
  const policies = {};
  for (const select of $("politicas").querySelectorAll("select")) policies[select.dataset.app] = select.value;
  const retencao = $("retencao").value;
  return {
    web_url: $("web-url").value.trim(),
    api_url: $("api-url").value.trim() || null,
    ca_path: $("ca-path").value.trim() || null,
    detection_enabled: $("deteccao").checked,
    policies,
    retention_days: retencao === "sempre" ? null : Number(retencao),
    pat: esquecerPat ? null : $("pat").value.trim() || null,
    clear_pat: esquecerPat,
  };
}

async function salvarConfig(esquecerPat) {
  const status = $("config-status");
  status.textContent = "Salvando…";
  try {
    desenharConfig(await invoke("save_settings", { input: lerConfig(esquecerPat) }));
    status.textContent = "Salvo.";
    atualizar();
  } catch (erro) {
    status.textContent = String(erro);
  }
}

$("alternar").addEventListener("click", async (evento) => {
  const botao = evento.currentTarget;
  botao.disabled = true;
  try {
    desenharStatus(await invoke("toggle_recording"));
  } catch (erro) {
    mostrar("aviso", String(erro));
  } finally {
    botao.disabled = false;
    atualizar();
  }
});

$("pergunta-gravar").addEventListener("click", () => invoke("answer_meeting", { record: true }));
$("pergunta-ignorar").addEventListener("click", () => invoke("answer_meeting", { record: false }));
$("sincronizar").addEventListener("click", () => invoke("sync_now").catch((erro) => mostrar("aviso-sync", String(erro))));
$("abrir-web").addEventListener("click", () => invoke("open_web").catch((erro) => mostrar("aviso", String(erro))));
$("esquecer-pat").addEventListener("click", () => salvarConfig(true));
$("form-config").addEventListener("submit", (evento) => {
  evento.preventDefault();
  salvarConfig(false);
});

listen("status-changed", atualizar);
setInterval(() => { if (!document.hidden) atualizar(); }, 1000);
atualizar();
carregarConfig();
