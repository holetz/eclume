// Montagem de DOM sem innerHTML: texto vindo do servidor ou do disco nunca vira marcação.

/**
 * Cria um elemento. `attrs` aceita atributos comuns, `class`, `dataset` (objeto), `on` (objeto de
 * eventos) e booleanos (`true` põe o atributo vazio, `false`/`null` o omite). Filhos podem ser
 * nós, textos ou listas; `null` e `false` são ignorados.
 */
export function el(tag, attrs = {}, ...filhos) {
  const elemento = document.createElement(tag);
  for (const [nome, valor] of Object.entries(attrs ?? {})) {
    if (valor == null || valor === false) continue;
    if (nome === "dataset") Object.assign(elemento.dataset, valor);
    else if (nome === "on") for (const [evento, fn] of Object.entries(valor)) elemento.addEventListener(evento, fn);
    else if (nome === "class") elemento.className = valor;
    else if (nome in elemento && typeof valor !== "string") elemento[nome] = valor;
    else elemento.setAttribute(nome, valor === true ? "" : valor);
  }
  anexar(elemento, filhos);
  return elemento;
}

function anexar(pai, filhos) {
  for (const filho of filhos) {
    if (filho == null || filho === false) continue;
    if (Array.isArray(filho)) anexar(pai, filho);
    else pai.append(filho instanceof Node ? filho : String(filho));
  }
}

/** Troca os filhos de `pai`. */
export function trocar(pai, ...filhos) {
  pai.replaceChildren();
  anexar(pai, filhos);
}

/** O elemento de `raiz` que casa com o seletor; falha alto se a marcação mudou. */
export function $(seletor, raiz = document) {
  const elemento = raiz.querySelector(seletor);
  if (!elemento) throw new Error(`elemento ausente: ${seletor}`);
  return elemento;
}
