// "Importar um arquivo" (frame "Import file" do DS): o arquivo chega pelo diálogo, arrastado para
// a janela ou pelo item da bandeja; a vista mostra o nome, a duração e a data de gravação lida do
// arquivo, que a pessoa confirma ou corrige, e acompanha a conversão até a fila de envio.
import { $ } from "../dom.js";
import { cronometro } from "./principal.js";

/** "2026-09-19T14:02" em hora local, o valor do `datetime-local`. */
export function paraCampo(ms) {
  const d = new Date(ms);
  const dois = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}T${dois(d.getHours())}:${dois(d.getMinutes())}`;
}

/** O texto da `.date-source` pela origem da data. */
export function origemDaData(origem) {
  return origem === "file_mtime"
    ? "Gravado em · data de modificação do arquivo; confira."
    : "Gravado em · lida do arquivo. Mude se estiver errada.";
}

export function montar(secao, app) {
  const arquivo = $("#importar-arquivo", secao);
  const data = $("#importar-data", secao);
  const confirmar = $("#importar-confirmar", secao);
  const andamento = $("#importar-andamento", secao);
  const erro = $("#importar-erro", secao);
  /** O arquivo lido (`probe_import`) e o valor inicial do campo de data. */
  let atual = null;
  let dataInicial = "";
  let convertendo = false;

  function mostrarErro(texto) {
    erro.hidden = !texto;
    $("#importar-erro-texto", erro).textContent = texto ?? "";
  }

  function limpar() {
    atual = null;
    convertendo = false;
    arquivo.hidden = true;
    andamento.hidden = true;
    confirmar.disabled = false;
    mostrarErro(null);
  }

  async function abrir(caminho) {
    limpar();
    try {
      const lido = await app.invoke("probe_import", { path: caminho });
      if (!lido.has_audio) {
        mostrarErro(`${lido.name} não tem áudio.`);
        return;
      }
      atual = lido;
      const duracao = lido.duration_ms == null ? "" : ` · ${cronometro(lido.duration_ms)}`;
      $("#importar-nome", secao).textContent = `${lido.name}${duracao}`;
      dataInicial = paraCampo(lido.recorded_at);
      data.value = dataInicial;
      $("#importar-origem", secao).textContent = origemDaData(lido.date_origin);
      arquivo.hidden = false;
    } catch (falha) {
      mostrarErro(String(falha));
    }
  }

  async function escolher() {
    try {
      const caminho = await app.invoke("pick_import_file");
      if (caminho) await abrir(caminho);
    } catch (falha) {
      mostrarErro(String(falha));
    }
  }

  async function importar() {
    if (!atual || !data.value) return;
    const mudou = data.value !== dataInicial;
    const recordedAt = mudou ? new Date(data.value).getTime() : atual.recorded_at;
    convertendo = true;
    confirmar.disabled = true;
    andamento.hidden = false;
    mostrarErro(null);
    try {
      await app.invoke("import_file", {
        path: atual.path,
        recordedAt,
        recordedAtSource: mudou ? "user" : "file_metadata",
      });
    } catch (falha) {
      convertendo = false;
      confirmar.disabled = false;
      andamento.hidden = true;
      mostrarErro(String(falha));
    }
  }

  function progresso(fracao) {
    $("#importar-progresso", secao).value = fracao;
    $("#importar-porcento", secao).textContent = `${Math.round(fracao * 100)}%`;
  }

  $("#importar-escolher", secao).addEventListener("click", (evento) => {
    evento.preventDefault();
    escolher();
  });
  $("#importar-alvo", secao).addEventListener("click", (evento) => {
    if (evento.target.closest("a")) return;
    evento.preventDefault();
    escolher();
  });
  confirmar.addEventListener("click", importar);
  $("#importar-cancelar", secao).addEventListener("click", async () => {
    if (convertendo) await app.invoke("cancel_import").catch(() => {});
    limpar();
    app.voltar();
  });
  $("#importar-fechar", secao).addEventListener("click", () => app.voltar());

  app.listen("import-progress", ({ payload }) => progresso(payload));
  app.listen("import-finished", () => {
    if (!convertendo) return;
    limpar();
    app.voltar();
    app.atualizar();
  });
  app.listen("import-failed", ({ payload }) => {
    if (!convertendo) return;
    convertendo = false;
    confirmar.disabled = false;
    andamento.hidden = true;
    mostrarErro(payload);
  });

  return {
    entrar(params) {
      if (params?.path) abrir(params.path);
      else if (!convertendo) limpar();
    },
  };
}
