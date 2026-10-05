// O painel "Recentes" do topo da principal: as últimas N gravações da conta (o comando `recent`,
// montado no Rust a partir da fila local e da API), cada uma numa linha com o estado, o progresso,
// o alerta quando a pessoa precisa agir e a ação da linha — Copiar resumo, Abrir no web ou
// Tentar agora. Os rótulos saem do vocabulário compartilhado; estado nunca só por cor.
import { el, trocar, $ } from "./dom.js";
import { preencherIcones } from "./icones.js";
import { ESTADOS_APARELHO, ESTADOS_SERVIDOR, ESTADOS_ETAPA, ETAPAS, motivo, nomeDaEtapa, fraseDaEspera } from "./vocabulario.js";

/** Quanto o retorno de uma ação ("Copiado", o erro) fica na linha. */
const RETORNO_MS = 2500;

/** "1 precisa de você", "3 precisam de você". */
export function contagemDeAlertas(n) {
  return n === 1 ? "1 precisa de você" : `${n} precisam de você`;
}

/** O rótulo enquanto a etapa anda ("Resumindo"), ou o nome dela. */
function andamento(etapa) {
  return ETAPAS.find((item) => item.etapa === etapa)?.andamento ?? nomeDaEtapa(etapa);
}

/**
 * O rótulo e o tom do `.badge` de uma linha, pela fase que o Rust classificou.
 * @returns {{ rotulo: string, tom: string }}
 */
export function situacao(item) {
  switch (item.phase) {
    case "recording":
      return ESTADOS_APARELHO.recording;
    case "pending":
      return ESTADOS_APARELHO.pending;
    case "uploading":
      return ESTADOS_APARELHO.uploading;
    case "upload_failed":
      return ESTADOS_APARELHO.failed;
    case "uploaded":
      return ESTADOS_APARELHO.uploaded;
    case "queued":
      return ESTADOS_SERVIDOR.na_fila;
    case "transcribing":
      return { rotulo: andamento("transcription"), tom: "progress" };
    case "processing":
      return { rotulo: item.stage ? andamento(item.stage) : ESTADOS_SERVIDOR.em_andamento.rotulo, tom: "progress" };
    case "summary_ready":
      return { rotulo: "Resumo pronto", tom: "success" };
    case "transcribed":
      return ESTADOS_SERVIDOR.pronta;
    case "no_summary":
      return { rotulo: "Pronta sem resumo", tom: item.attention ? "warning" : "neutral" };
    case "summary_failed":
      return { rotulo: "O resumo falhou", tom: "danger" };
    case "transcription_failed":
      return { rotulo: "A transcrição falhou", tom: "danger" };
    case "cancelled":
      return ESTADOS_SERVIDOR.cancelada;
    default: {
      // A etapa `speakers` em `waiting` (contrato 2.22.0) chega aqui como alerta: "Aguardando
      // locutores", com o link para o web. Outro estado que este app não conhece (o servidor é mais
      // novo): o rótulo do vocabulário, se já houver, senão "Precisa de você".
      if (item.stage === "speakers" && item.detail === "waiting") return ESTADOS_SERVIDOR.aguardando_locutores;
      const conhecido = ESTADOS_SERVIDOR[item.detail]?.rotulo;
      return { rotulo: conhecido ?? "Precisa de você", tom: "warning" };
    }
  }
}

/** A linha de detalhe sob a gravação: o motivo do alerta, a espera ou nada. */
export function detalhe(item, agora = new Date()) {
  switch (item.phase) {
    case "upload_failed":
      return item.detail ?? "O envio falhou; o app tenta de novo sozinho.";
    case "queued":
      return fraseDaEspera(item.wait, agora);
    case "no_summary":
      return item.reason ? motivo(item.reason) : null;
    case "summary_failed":
      return "Abra no web para gerar o resumo de novo.";
    case "transcription_failed":
      return item.attention ? "Abra no web para ver o motivo." : "Falha passageira; o servidor tenta de novo.";
    case "unknown": {
      const etapa = item.stage ? `${nomeDaEtapa(item.stage)}: ` : "";
      const estado = ESTADOS_ETAPA[item.detail] ?? item.detail ?? "";
      const porque = item.reason ? ` · ${motivo(item.reason)}` : "";
      return `${etapa}${estado}${porque} · resolva no web.`;
    }
    default:
      return null;
  }
}

function doisDigitos(n) {
  return String(n).padStart(2, "0");
}

/** "05/10 14:02": a data de uma linha sem título. */
export function dataCurta(instante) {
  const data = new Date(instante);
  if (Number.isNaN(data.getTime())) return "Gravação";
  return `${doisDigitos(data.getDate())}/${doisDigitos(data.getMonth() + 1)} ${doisDigitos(data.getHours())}:${doisDigitos(data.getMinutes())}`;
}

function tituloDa(item) {
  if (item.title?.trim()) return item.title;
  return dataCurta(item.started_at ?? item.created_at);
}

/** Monta o painel em `raiz` (o `#recentes` da principal). */
export function montarRecentes(raiz, app) {
  const lista = $("#recentes-lista", raiz);
  const alerta = $("#recentes-alerta", raiz);
  const vazio = $("#recentes-vazio", raiz);
  /** O retorno de uma ação por linha (chave → { texto, erro, ate }), que sobrevive ao redesenho. */
  const retornos = new Map();
  let ultimo = null;

  function avisar(chave, texto, erro = false) {
    retornos.set(chave, { texto, mensagem: texto, erro, ate: Date.now() + RETORNO_MS });
    desenhar(ultimo);
    setTimeout(() => desenhar(ultimo), RETORNO_MS + 50);
  }

  async function agir(chave, comando, args, sucesso) {
    try {
      await app.invoke(comando, args);
      if (sucesso) avisar(chave, sucesso);
    } catch (falha) {
      avisar(chave, String(falha), true);
    }
  }

  function acao(item) {
    const chave = item.key;
    if (item.phase === "summary_ready" && item.remote_id) {
      const retorno = retornos.get(chave);
      const copiado = retorno && !retorno.erro;
      const botao = el(
        "button",
        {
          type: "button",
          class: "btn btn-secondary btn-sm recente-copiar",
          dataset: { icone: "copiar" },
          on: {
            click: () => agir(chave, "copy_summary", { recordingId: item.remote_id }, "Resumo copiado em Markdown."),
          },
        },
        copiado ? "Copiado" : "Copiar resumo",
      );
      return botao;
    }
    if (item.attention === "upload_failed") {
      return el(
        "button",
        { type: "button", class: "btn btn-ghost btn-sm", on: { click: () => agir(chave, "sync_now", undefined, "Enviando…") } },
        "Tentar agora",
      );
    }
    if (item.attention && item.remote_id) {
      return el(
        "button",
        {
          type: "button",
          class: "btn btn-ghost btn-sm",
          on: { click: () => agir(chave, "open_recording", { recordingId: item.remote_id }) },
        },
        "Abrir no web",
      );
    }
    return null;
  }

  function progresso(item) {
    if (item.phase !== "transcribing" || item.progress == null) return null;
    const porcento = Math.round(item.progress / 10);
    return el(
      "span",
      { class: "recente-progresso" },
      el("progress", { class: "progress", max: 100, value: porcento, "aria-label": `Transcrição ${porcento}%` }),
      el("span", { class: "mono tiny" }, `${porcento}%`),
    );
  }

  function linha(item, agora) {
    const { rotulo, tom } = situacao(item);
    const retorno = retornos.get(item.key);
    const texto = retorno?.erro ? retorno.texto : detalhe(item, agora);
    return el(
      "li",
      { dataset: { key: item.key, fase: item.phase }, class: item.attention ? "recente recente-alerta" : "recente" },
      el("span", { class: "recente-titulo", title: tituloDa(item) }, tituloDa(item)),
      el("span", { class: tom === "neutral" ? "badge" : `badge badge-${tom}` }, rotulo),
      acao(item) ?? el("span"),
      progresso(item),
      texto ? el("span", { class: retorno?.erro || item.attention ? "recente-detalhe recente-motivo" : "recente-detalhe" }, texto) : null,
      retorno && !retorno.erro ? el("span", { class: "recente-detalhe", role: "status" }, retorno.mensagem) : null,
    );
  }

  function desenhar(painel) {
    ultimo = painel;
    const agora = Date.now();
    for (const [chave, retorno] of retornos) if (retorno.ate < agora) retornos.delete(chave);
    raiz.hidden = !painel || painel.count === 0;
    if (raiz.hidden) return;
    const itens = painel.items ?? [];
    trocar(
      lista,
      itens.map((item) => linha(item, new Date(agora))),
    );
    preencherIcones(lista);
    alerta.hidden = !painel.needs_you;
    alerta.textContent = painel.needs_you ? contagemDeAlertas(painel.needs_you) : "";
    vazio.hidden = itens.length > 0;
    vazio.textContent = painel.error && !painel.fetched_at ? "Sem resposta do servidor; tentando de novo." : "Nenhuma gravação ainda.";
  }

  return { desenhar };
}
