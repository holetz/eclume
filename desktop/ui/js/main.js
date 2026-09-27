// Janela do app desktop: roteia as vistas (uma <section data-vista> cada), aplica o tema do
// sistema, trata as teclas da janela e consulta o estado do Rust a cada segundo.
import { invoke, listen } from "./tauri.js";
import { preencherIcones } from "./icones.js";
import * as principal from "./vistas/principal.js";
import * as primeiraExecucao from "./vistas/primeira-execucao.js";
import * as importar from "./vistas/importar.js";
import * as configuracoes from "./vistas/configuracoes.js";
import * as ajuda from "./vistas/ajuda.js";

/** As vistas registradas: nome → { entrar?(params), sair?(), atualizar?(estado) }. */
const vistas = new Map();
let atual = null;

/** O que as vistas recebem ao montar. */
const app = {
  invoke,
  listen,
  /** O último retrato do estado (`status`) e a fila (`recordings`). */
  estado: null,
  fila: [],
  ir,
  voltar: () => ir("principal"),
  atualizar,
};

/** Registra a vista cuja seção já está no HTML: `modulo.montar(secao, app)` devolve a vista. */
function registrar(nome, modulo) {
  vistas.set(nome, modulo.montar(document.querySelector(`[data-vista="${nome}"]`), app));
}

/** Mostra a vista `nome`; devolve `false` se ela não existe. */
function ir(nome, params) {
  const vista = vistas.get(nome);
  if (!vista) return false;
  if (atual && atual !== nome) vistas.get(atual).sair?.();
  menuDeAjuda?.fechar();
  for (const outra of document.querySelectorAll("[data-vista]")) outra.hidden = outra.dataset.vista !== nome;
  atual = nome;
  vista.entrar?.(params);
  if (app.estado) vista.atualizar?.(app.estado, app.fila);
  return true;
}

async function atualizar() {
  try {
    const [estado, fila] = await Promise.all([invoke("status"), invoke("recordings", { limit: 50 })]);
    app.estado = estado;
    app.fila = fila;
    // Sem credencial (ou com a CA do servidor trocada), a janela fica na primeira execução.
    if (estado.connection === "first_run" && atual !== "primeira-execucao") ir("primeira-execucao");
    else vistas.get(atual)?.atualizar?.(estado, fila);
  } catch (erro) {
    console.error(erro);
  }
}

function aplicarTema(escuro) {
  document.documentElement.dataset.theme = escuro ? "dark" : "light";
}

/** Teclas da janela; os atalhos globais são do Rust. */
function aoTeclar(evento) {
  if (app.estado?.connection === "first_run") return;
  if (evento.key === "Escape") {
    if (atual !== "principal" && ir("principal")) evento.preventDefault();
    return;
  }
  if (!(evento.ctrlKey || evento.metaKey) || evento.altKey) return;
  const destino = { o: "importar", ",": "configuracoes", "/": "atalhos" }[evento.key.toLowerCase()];
  if (destino && ir(destino)) evento.preventDefault();
}

registrar("principal", principal);
registrar("primeira-execucao", primeiraExecucao);
registrar("importar", importar);
registrar("configuracoes", configuracoes);
registrar("atalhos", ajuda);
const menuDeAjuda = ajuda.ligarMenu(app);

const temaEscuro = window.matchMedia("(prefers-color-scheme: dark)");
aplicarTema(temaEscuro.matches);
temaEscuro.addEventListener("change", (evento) => aplicarTema(evento.matches));
preencherIcones();
document.addEventListener("keydown", aoTeclar);
ir("principal");
listen("status-changed", atualizar);
// Arquivo arrastado para a janela ou escolhido pela bandeja.
listen("import-dropped", ({ payload }) => ir("importar", { path: payload }));
setInterval(() => {
  if (!document.hidden) atualizar();
}, 1000);
atualizar();
