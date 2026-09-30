// Ajuda do desktop (frame "Desktop help menu and shortcuts" do DS): o menu ancorado no ícone de
// ajuda da janela principal e a folha "Atalhos de teclado" (Ctrl+/).
import { el, trocar, $ } from "../dom.js";
import { versao } from "../tauri.js";
import { MAC, teclas } from "./principal.js";

/** As teclas da janela (as globais vêm das configurações). */
const DA_JANELA = [
  ["Importar arquivo", "O"],
  ["Configurações", ","],
  ["Atalhos de teclado", "/"],
];

/** Uma combinação em teclas separadas: ["⌘", "⇧", "N"] ou ["Ctrl", "Alt", "N"]. */
export function partes(atalho, mac = MAC) {
  return mac ? [...teclas(atalho, true)] : atalho.split("+");
}

function linha(rotulo, atalho) {
  return el(
    "div",
    {},
    el("dt", {}, rotulo),
    el(
      "dd",
      {},
      partes(atalho).map((tecla) => el("span", { class: "kbd" }, tecla)),
    ),
  );
}

/** Liga o menu de ajuda da janela principal. */
export function ligarMenu(app) {
  const botao = $("#abrir-ajuda");
  const menu = $("#menu-ajuda");

  function abrir(sim) {
    menu.hidden = !sim;
    botao.setAttribute("aria-expanded", String(sim));
    if (sim) menu.querySelector("[role=menuitem]")?.focus();
  }

  async function executar(comando, args) {
    abrir(false);
    try {
      await app.invoke(comando, args);
    } catch (falha) {
      console.error(falha);
    }
  }

  botao.addEventListener("click", (evento) => {
    evento.stopPropagation();
    abrir(menu.hidden);
  });
  document.addEventListener("click", (evento) => {
    if (!menu.hidden && !menu.contains(evento.target)) abrir(false);
  });
  menu.addEventListener("keydown", (evento) => {
    if (evento.key === "Escape") {
      evento.stopPropagation();
      abrir(false);
      botao.focus();
    }
  });
  $("#ajuda-primeiros-passos").addEventListener("click", () => executar("open_help", { article: "primeiros-passos" }));
  $("#ajuda-permissoes").addEventListener("click", () =>
    executar("open_help", { article: "permissoes-de-microfone" }),
  );
  $("#ajuda-pasta").addEventListener("click", () => executar("open_help", { article: "pasta-sincronizada" }));
  $("#ajuda-atalhos").addEventListener("click", () => {
    abrir(false);
    app.ir("atalhos");
  });
  $("#ajuda-central").addEventListener("click", () => executar("open_help", { article: null }));
  $("#ajuda-problema").addEventListener("click", () => executar("open_log_dir"));
  $("#ajuda-atalhos-tecla").textContent = MAC ? "⌘/" : "Ctrl+/";

  versao().then((numero) => {
    $("#ajuda-versao").textContent = `eclume ${numero} · atualizado`;
  });

  return { fechar: () => abrir(false) };
}

/** A folha "Atalhos de teclado". */
export function montar(secao, app) {
  $("#atalhos-fechar", secao).addEventListener("click", () => app.voltar());
  $("#atalhos-mudar", secao).addEventListener("click", (evento) => {
    evento.preventDefault();
    app.ir("configuracoes", { aba: "audio" });
  });
  const modificador = MAC ? "Cmd" : "Ctrl";
  trocar(
    $("#atalhos-janela", secao),
    DA_JANELA.map(([rotulo, tecla]) => linha(rotulo, `${modificador}+${tecla}`)),
  );

  return {
    async entrar() {
      try {
        const config = await app.invoke("settings");
        trocar(
          $("#atalhos-globais", secao),
          config.shortcuts.map((atalho) => linha(atalho.label, atalho.keys)),
        );
      } catch (falha) {
        console.error(falha);
      }
    },
  };
}
