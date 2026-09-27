// A janela principal (frame "Main window" do DS): linha de status, gravar, nova nota e importar,
// a pergunta de reunião detectada, a fila de envio e a conta.
import { el, trocar, $ } from "../dom.js";
import { versao } from "../tauri.js";

const MIN = 60_000;
const DIA = 24 * 60 * MIN;

/** Como cada estado da fila aparece: rótulo e variante do `.badge`. */
const SITUACOES = {
  recording: ["Gravando", "badge-progress"],
  pending: ["Na fila", ""],
  syncing: ["Enviando", "badge-progress"],
  synced: ["Enviada", "badge-success"],
  failed: ["Falhou", "badge-danger"],
};

export const MAC = /Mac/.test(navigator.platform || navigator.userAgent);

const horaMinuto = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const diaMes = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });

/** "Hoje, 09:00", "Ontem, 16:40" ou "19/09, 14:02". */
export function quando(ms, agora = Date.now()) {
  const inicioDoDia = new Date(agora).setHours(0, 0, 0, 0);
  const hora = horaMinuto.format(ms);
  if (ms >= inicioDoDia) return `Hoje, ${hora}`;
  if (ms >= inicioDoDia - DIA) return `Ontem, ${hora}`;
  return `${diaMes.format(ms)}, ${hora}`;
}

/** "42 s", "54 min" ou "1 h 05 min". */
export function duracao(ms) {
  if (ms == null) return null;
  if (ms < MIN) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const minutos = Math.round(ms / MIN);
  if (minutos < 60) return `${minutos} min`;
  return `${Math.floor(minutos / 60)} h ${String(minutos % 60).padStart(2, "0")} min`;
}

/** O tempo corrido de uma gravação: "12:04" ou "1:02:09". */
export function cronometro(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** A linha de status e o `data-status` dela. */
export function linhaDeStatus(estado, detectando, agora = Date.now()) {
  const faltam = estado.counts.pending + estado.counts.syncing + estado.counts.failed;
  if (estado.status === "recording") {
    const tempo = estado.recording_started_at ? ` · ${cronometro(agora - estado.recording_started_at)}` : "";
    const origem = estado.recording_app ? ` ${estado.recording_app.label}` : "";
    return ["recording", `Gravando${origem}${tempo}`];
  }
  if (estado.status === "syncing") {
    return ["syncing", faltam === 1 ? "Enviando 1 gravação" : `Enviando ${faltam} gravações`];
  }
  if (estado.meeting) return ["idle", `Reunião no ${estado.meeting.label}`];
  if (detectando) return ["idle", "Ocioso, atento a reuniões"];
  if (faltam === 0) return ["synced", "Tudo enviado"];
  return ["idle", faltam === 1 ? "Ocioso · 1 gravação na fila" : `Ocioso · ${faltam} gravações na fila`];
}

function rotuloDaGravacao(gravacao, agora) {
  const partes = [gravacao.original_name ?? quando(gravacao.started_at, agora)];
  if (gravacao.kind === "note") partes.push("Nota");
  partes.push(duracao(gravacao.duration_ms));
  if (gravacao.interrupted) partes.push("interrompida");
  return partes.filter(Boolean).join(" · ");
}

export function montar(secao, app) {
  const linha = $("#linha-status", secao);
  const gravar = $("#gravar", secao);
  const pergunta = $("#pergunta", secao);
  const fila = $("#fila", secao);
  const aviso = $("#aviso", secao);
  let configuracoes = null;
  /** O erro do último comando da janela; some no próximo que der certo. */
  let erro = null;

  $("#atalho-nota", secao).textContent = MAC ? "⌘⇧N" : "Ctrl+Alt+N";

  function desenharAviso(estado) {
    const [titulo, texto, tom] = erro
      ? ["Não deu certo", erro, "alert-error"]
      : estado.notice
        ? ["Aviso", estado.notice, "alert-warning"]
        : ["Envio", estado.sync_notice, "alert-warning"];
    aviso.hidden = !texto;
    aviso.className = `alert ${tom}`;
    $("#aviso-titulo", aviso).textContent = titulo;
    $("#aviso-texto", aviso).textContent = texto ?? "";
  }

  async function executar(comando, args) {
    try {
      const resposta = await app.invoke(comando, args);
      erro = null;
      return resposta;
    } catch (falha) {
      erro = String(falha);
      return null;
    } finally {
      app.atualizar();
    }
  }

  gravar.addEventListener("click", async () => {
    gravar.disabled = true;
    await executar("toggle_recording");
    gravar.disabled = false;
  });
  $("#nova-nota", secao).addEventListener("click", () => executar("new_note"));
  $("#importar", secao).addEventListener("click", () => app.ir("importar"));
  $("#abrir-configuracoes", secao).addEventListener("click", () => app.ir("configuracoes"));
  $("#pergunta-gravar", secao).addEventListener("click", () => executar("answer_meeting", { record: true }));
  $("#pergunta-agora-nao", secao).addEventListener("click", () => executar("answer_meeting", { record: false }));
  $("#conta-servidor", secao).addEventListener("click", (evento) => {
    evento.preventDefault();
    executar("open_web");
  });
  $("#conta-acao", secao).addEventListener("click", (evento) => {
    evento.preventDefault();
    app.ir("configuracoes", { aba: "servidor" });
  });

  function desenharConta() {
    if (!configuracoes) return;
    const host = new URL(configuracoes.web_url).hostname;
    $("#conta-nome", secao).textContent = configuracoes.pat_source ? "Conectado com um token pessoal" : "Sem conexão com o servidor";
    $("#conta-servidor", secao).textContent = `eclume em ${host}`;
    $("#conta-acao", secao).textContent = configuracoes.pat_source ? "Servidor" : "Conectar";
  }

  function desenharFila(gravacoes, agora) {
    trocar(
      fila,
      gravacoes.map((gravacao) => {
        const [rotulo, variante] = SITUACOES[gravacao.status] ?? [gravacao.status, ""];
        return el(
          "li",
          { dataset: { id: gravacao.id } },
          el("span", {}, rotuloDaGravacao(gravacao, agora)),
          el("span", { class: `badge ${variante}`.trim(), title: gravacao.last_error ?? null }, rotulo),
        );
      }),
    );
    $("#fila-vazia", secao).hidden = gravacoes.length > 0;
    const enviadas = gravacoes.filter((g) => g.status === "synced").length;
    $("#fila-resumo", secao).textContent = gravacoes.length ? `${enviadas} de ${gravacoes.length} enviadas` : "";
  }

  return {
    async entrar() {
      const [lidas, numero] = await Promise.all([app.invoke("settings"), versao()]);
      configuracoes = lidas;
      $("#conta-versao", secao).textContent = `v${numero}`;
      desenharConta();
      if (app.estado) this.atualizar(app.estado, app.fila);
    },

    atualizar(estado, gravacoes) {
      const agora = Date.now();
      const [status, texto] = linhaDeStatus(estado, configuracoes?.detection_enabled ?? false, agora);
      linha.dataset.status = status;
      linha.textContent = texto;

      const gravando = estado.status === "recording";
      gravar.setAttribute("aria-pressed", String(gravando));
      gravar.textContent = gravando ? "Parar gravação" : "Iniciar gravação";

      pergunta.hidden = !estado.pending_ask;
      if (estado.pending_ask) {
        $("#pergunta-texto", pergunta).textContent = `${estado.pending_ask.label} está usando o microfone. Gravar?`;
      }

      desenharAviso(estado);
      desenharFila(gravacoes, agora);
    },
  };
}
