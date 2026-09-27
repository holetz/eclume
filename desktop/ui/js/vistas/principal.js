// A janela principal (frame "Main window" do DS): linha de status, gravar, nova nota e importar,
// o medidor da nota, os marcadores e a política do app durante a gravação automática, a pergunta
// de reunião detectada, a fila de envio e a conta.
import { el, trocar, $ } from "../dom.js";
import { versao } from "../tauri.js";
import { rotuloDoServidor } from "./primeira-execucao.js";

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

/** Os atalhos globais padrão, até as configurações chegarem. */
const ATALHOS_PADRAO = MAC
  ? { record: "Cmd+Shift+R", note: "Cmd+Shift+N", marker: "Cmd+Shift+K" }
  : { record: "Ctrl+Alt+R", note: "Ctrl+Alt+N", marker: "Ctrl+Alt+M" };

const SIMBOLOS_MAC = { cmd: "⌘", command: "⌘", super: "⌘", shift: "⇧", alt: "⌥", option: "⌥", ctrl: "⌃", control: "⌃" };

/** Um atalho como a pessoa o lê: "⌘⇧N" no macOS, "Ctrl+Alt+N" nos outros. */
export function teclas(atalho, mac = MAC) {
  if (!mac) return atalho;
  return atalho
    .split("+")
    .map((parte) => SIMBOLOS_MAC[parte.trim().toLowerCase()] ?? parte.trim())
    .join("");
}

/** Barras do medidor abaixo disso aparecem como silêncio. */
const NIVEL_QUIETO = 0.15;

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

/** O tempo da nota no botão de parar: "00:00:42". */
export function relogio(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
}

/** A linha de status e o `data-status` dela. */
export function linhaDeStatus(estado, detectando, agora = Date.now()) {
  const faltam = estado.counts.pending + estado.counts.syncing + estado.counts.failed;
  if (estado.status === "recording" && estado.recording_kind === "note") {
    const parada = estado.note_silence_s ? ` · para depois de ${estado.note_silence_s} s de silêncio` : "";
    return ["recording", `Gravando uma nota${parada}`];
  }
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

/** "1 marcador", "3 marcadores". */
export function contagemDeMarcadores(n) {
  return n === 1 ? "1 marcador" : `${n} marcadores`;
}

export function montar(secao, app) {
  const linha = $("#linha-status", secao);
  const gravar = $("#gravar", secao);
  const pergunta = $("#pergunta", secao);
  const fila = $("#fila", secao);
  const aviso = $("#aviso", secao);
  const nota = $("#nota", secao);
  const medidor = $("#medidor", secao);
  const marcadores = $("#marcadores", secao);
  const notaMarcador = $("#nota-marcador", secao);
  const textoMarcador = $("#nota-marcador-texto", secao);
  const politica = $("#politica", secao);
  let configuracoes = null;

  // "Atualizado para X" (frame "After an update"): no topo da janela até a pessoa fechar.
  const atualizado = el(
    "div",
    { class: "alert alert-success", id: "atualizado", role: "status", hidden: true },
    el("span", { class: "alert-title", id: "atualizado-titulo" }),
    el("span", { id: "atualizado-notas" }),
    el(
      "button",
      {
        type: "button",
        class: "btn btn-ghost btn-sm",
        id: "atualizado-fechar",
        on: { click: () => executar("dismiss_update_notice") },
      },
      "Entendi",
    ),
  );
  $(".tray-section", secao).prepend(atualizado);

  function desenharAtualizacao(estado) {
    const novo = estado.updated;
    atualizado.hidden = !novo;
    if (!novo) return;
    $("#atualizado-titulo", atualizado).textContent = `Atualizado para ${novo.version}`;
    $("#atualizado-notas", atualizado).textContent = novo.notes ?? "";
  }
  /** O erro do último comando da janela; some no próximo que der certo. */
  let erro = null;
  /** O marcador cuja nota o campo mostra. */
  let marcadorEditado = null;
  /** A consulta ao medidor, a cada 100 ms, enquanto houver nota. */
  let consultaDoMedidor = null;

  const barras = Array.from({ length: 16 }, () => el("i"));
  trocar(medidor, barras);

  function desenharAtalhos() {
    const atalhos = { ...ATALHOS_PADRAO };
    for (const atalho of configuracoes?.shortcuts ?? []) atalhos[atalho.action] = atalho.keys;
    $("#atalho-nota", secao).textContent = teclas(atalhos.note);
    $("#atalho-marcador", secao).textContent = teclas(atalhos.marker);
  }
  desenharAtalhos();

  function desenharMedidor(leitura) {
    leitura.levels.forEach((nivel, i) => {
      barras[i].style.setProperty("--h", `${Math.round(Math.max(0.08, nivel) * 100)}%`);
      barras[i].toggleAttribute("data-quiet", nivel < NIVEL_QUIETO);
    });
    $("#nota-silencio", secao).textContent =
      leitura.stops_in_ms == null ? "" : `Silêncio · para em ${Math.max(1, Math.ceil(leitura.stops_in_ms / 1000))} s`;
    gravar.textContent = `Parar nota · ${relogio(leitura.position_ms)}`;
  }

  async function consultarMedidor() {
    try {
      const leitura = await app.invoke("note_meter");
      if (leitura) desenharMedidor(leitura);
    } catch (falha) {
      console.error(falha);
    }
  }

  function acompanharNota(ligar) {
    if (ligar && !consultaDoMedidor) {
      consultaDoMedidor = setInterval(consultarMedidor, 100);
      consultarMedidor();
    } else if (!ligar && consultaDoMedidor) {
      clearInterval(consultaDoMedidor);
      consultaDoMedidor = null;
    }
  }

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
    await executar(app.estado?.recording_kind === "note" ? "new_note" : "toggle_recording");
    gravar.disabled = false;
  });
  $("#marcador", secao).addEventListener("click", async () => {
    const marcador = await executar("add_marker", { note: null });
    if (marcador) {
      marcadorEditado = marcador;
      textoMarcador.value = "";
      notaMarcador.hidden = false;
      textoMarcador.focus();
    }
  });
  textoMarcador.addEventListener("change", () => {
    if (!marcadorEditado) return;
    const texto = textoMarcador.value.trim();
    executar("set_marker_note", { clientId: marcadorEditado.client_id, note: texto || null });
  });
  textoMarcador.addEventListener("keydown", (evento) => {
    if (evento.key === "Enter") textoMarcador.blur();
  });
  $("#politica-opcoes", secao).addEventListener("change", (evento) => mudarPolitica(evento.target.value));
  $("#politica-configuracoes", secao).addEventListener("click", (evento) => {
    evento.preventDefault();
    app.ir("configuracoes", { aba: "reunioes" });
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
  $("#conta-acao", secao).addEventListener("click", async (evento) => {
    evento.preventDefault();
    if (app.estado?.connection === "account") {
      await executar("sign_out");
    } else {
      app.ir("configuracoes", { aba: "servidor" });
    }
  });

  /** Troca a política do app da gravação automática em curso, pelas configurações salvas. */
  async function mudarPolitica(valor) {
    const appDaGravacao = app.estado?.recording_app?.app;
    if (!appDaGravacao) return;
    const atuais = await executar("settings");
    if (!atuais) return;
    const policies = Object.fromEntries(atuais.apps.map((a) => [a.app, a.app === appDaGravacao ? valor : a.policy]));
    const salvas = await executar("save_settings", {
      input: {
        web_url: atuais.web_url,
        api_url: atuais.api_url,
        ca_path: atuais.ca_path,
        detection_enabled: atuais.detection_enabled,
        policies,
        retention_days: atuais.retention_days,
      },
    });
    if (salvas) configuracoes = salvas;
  }

  function desenharGravacao(estado) {
    const gravando = estado.status === "recording";
    const emNota = gravando && estado.recording_kind === "note";
    gravar.setAttribute("aria-pressed", String(gravando));
    if (!emNota) gravar.textContent = gravando ? "Parar gravação" : "Iniciar gravação";
    nota.hidden = !emNota;
    acompanharNota(emNota);

    $("#gravacao-automatica", secao).hidden = !(gravando && estado.recording_auto);
    marcadores.hidden = !gravando;
    const contagem = $("#contagem-marcadores", secao);
    contagem.hidden = !estado.marker_count;
    contagem.textContent = contagemDeMarcadores(estado.marker_count ?? 0);
    const ultimo = gravando ? estado.last_marker : null;
    notaMarcador.hidden = !ultimo;
    if (ultimo && ultimo.client_id !== marcadorEditado?.client_id) {
      marcadorEditado = ultimo;
      textoMarcador.value = ultimo.note ?? "";
    }
    if (ultimo) $("#nota-marcador-rotulo", secao).textContent = `Nota do marcador em ${cronometro(ultimo.at_ms)}`;
    if (!gravando) marcadorEditado = null;

    const appAuto = gravando && estado.recording_auto ? estado.recording_app : null;
    politica.hidden = !appAuto;
    if (appAuto) {
      $("#politica-titulo", politica).textContent = `Reuniões no ${appAuto.label.replace(/^Microsoft /, "")}`;
      $("#politica-opcoes", politica).setAttribute("aria-label", appAuto.label);
      const atual = configuracoes?.apps.find((a) => a.app === appAuto.app)?.policy;
      for (const opcao of politica.querySelectorAll("input")) opcao.checked = opcao.value === atual;
    }
  }

  /** A conta, como no frame "Main window": o e-mail e "eclume em <host> · v0.2.0 · Sair". */
  function desenharConta(estado) {
    const conta = estado.account;
    $("#conta-nome", secao).textContent = conta?.email ?? "Conectado com um token pessoal";
    $("#conta-servidor", secao).textContent = rotuloDoServidor({ name: conta?.server_name, url: estado.web_url });
    $("#conta-acao", secao).textContent = estado.connection === "account" ? "Sair" : "Servidor";
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
    sair() {
      acompanharNota(false);
    },

    async entrar() {
      const [lidas, numero] = await Promise.all([app.invoke("settings"), versao()]);
      configuracoes = lidas;
      $("#conta-versao", secao).textContent = `v${numero}`;
      desenharAtalhos();
      if (app.estado) this.atualizar(app.estado, app.fila);
    },

    atualizar(estado, gravacoes) {
      const agora = Date.now();
      const [status, texto] = linhaDeStatus(estado, configuracoes?.detection_enabled ?? false, agora);
      linha.dataset.status = status;
      linha.textContent = texto;

      desenharGravacao(estado);

      pergunta.hidden = !estado.pending_ask;
      if (estado.pending_ask) {
        $("#pergunta-texto", pergunta).textContent = `${estado.pending_ask.label} está usando o microfone. Gravar?`;
      }

      desenharAviso(estado);
      desenharAtualizacao(estado);
      desenharConta(estado);
      desenharFila(gravacoes, agora);
    },
  };
}
