// Janela de status do app desktop do eclume. Sem bundler: usa a API global do Tauri.
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

let editandoUrl = false;

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

function mostrarAviso(texto) {
  const aviso = $("aviso");
  aviso.textContent = texto || "";
  aviso.hidden = !texto;
}

function desenharStatus(view) {
  const estado = $("estado");
  estado.dataset.status = view.status;
  estado.textContent = view.status === "recording" && view.recording_started_at
    ? `Gravando há ${duracao(Date.now() - view.recording_started_at)}`
    : ROTULOS[view.status];

  const alternar = $("alternar");
  const gravando = view.status === "recording";
  alternar.dataset.recording = String(gravando);
  alternar.textContent = gravando ? "Parar gravação" : "Iniciar gravação";

  const faltam = view.counts.pending + view.counts.syncing + view.counts.failed;
  $("resumo").textContent = faltam === 0 ? "" : `${faltam} a sincronizar`;
  mostrarAviso(view.notice);
  if (!editandoUrl) $("web-url").value = view.web_url;
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
      detalhe.textContent = [duracao(g.duration_ms), tamanho(g.bytes), g.interrupted ? "interrompida" : ""]
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
    mostrarAviso(String(erro));
  }
}

$("alternar").addEventListener("click", async (evento) => {
  const botao = evento.currentTarget;
  botao.disabled = true;
  try {
    desenharStatus(await invoke("toggle_recording"));
  } catch (erro) {
    mostrarAviso(String(erro));
  } finally {
    botao.disabled = false;
    atualizar();
  }
});

$("abrir-web").addEventListener("click", () => invoke("open_web").catch((erro) => mostrarAviso(String(erro))));

$("web-url").addEventListener("focus", () => { editandoUrl = true; });
$("web-url").addEventListener("blur", () => { editandoUrl = false; });

$("form-web").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  try {
    editandoUrl = false;
    desenharStatus(await invoke("set_web_url", { url: $("web-url").value }));
  } catch (erro) {
    mostrarAviso(String(erro));
  }
});

listen("status-changed", atualizar);
setInterval(() => { if (!document.hidden) atualizar(); }, 1000);
atualizar();
