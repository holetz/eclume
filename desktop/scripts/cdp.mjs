#!/usr/bin/env node
// Fala com a janela real do app desktop pelo CDP do WebView2 (ou do WebKitGTK/Chromium com a
// porta de depuração aberta), sem dependência: o `WebSocket` nativo do Node 22.
//
//   node desktop/scripts/cdp.mjs eval "<expressão>"     avalia na janela (com awaitPromise) e
//                                                        imprime o resultado em JSON
//   node desktop/scripts/cdp.mjs screenshot janela.png  grava a captura da janela
//
// A porta vem de CDP_PORT (padrão 9229), a de docs/project/estacao-windows.md: o app precisa ter
// aberto com WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9229".
import { writeFile } from "node:fs/promises";

const PORTA = Number(process.env.CDP_PORT ?? 9229);
const [comando, argumento] = process.argv.slice(2);

function uso() {
  console.error('uso: node desktop/scripts/cdp.mjs eval "<expressão>" | screenshot <arquivo.png>');
  process.exit(2);
}

/** O endereço WebSocket da janela do eclume (a primeira página, se o título não bater). */
async function alvo() {
  const resposta = await fetch(`http://127.0.0.1:${PORTA}/json/list`).catch((erro) => {
    throw new Error(`nenhuma janela com CDP em 127.0.0.1:${PORTA} (${erro.cause?.code ?? erro.message})`);
  });
  const paginas = (await resposta.json()).filter((t) => t.type === "page");
  const pagina = paginas.find((t) => t.title === "eclume") ?? paginas[0];
  if (!pagina) throw new Error(`nenhuma página em 127.0.0.1:${PORTA}`);
  return pagina.webSocketDebuggerUrl;
}

/** Abre a conexão e devolve `enviar(método, params)`, que resolve com o `result` do CDP. */
async function conectar(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error(`falha ao conectar em ${url}`)), { once: true });
  });
  let proximo = 0;
  const pendentes = new Map();
  ws.addEventListener("message", (evento) => {
    const mensagem = JSON.parse(evento.data);
    const pendente = pendentes.get(mensagem.id);
    if (!pendente) return;
    pendentes.delete(mensagem.id);
    if (mensagem.error) pendente.reject(new Error(mensagem.error.message));
    else pendente.resolve(mensagem.result);
  });
  const enviar = (method, params = {}) =>
    new Promise((resolve, reject) => {
      proximo += 1;
      pendentes.set(proximo, { resolve, reject });
      ws.send(JSON.stringify({ id: proximo, method, params }));
    });
  return { enviar, fechar: () => ws.close() };
}

async function main() {
  if (!argumento || !["eval", "screenshot"].includes(comando)) uso();
  const { enviar, fechar } = await conectar(await alvo());
  try {
    if (comando === "eval") {
      const { result, exceptionDetails } = await enviar("Runtime.evaluate", {
        expression: argumento,
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails) {
        throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      }
      console.log(JSON.stringify(result.value ?? null, null, 2));
    } else {
      const { data } = await enviar("Page.captureScreenshot", { format: "png" });
      await writeFile(argumento, Buffer.from(data, "base64"));
      console.log(argumento);
    }
  } finally {
    fechar();
  }
}

main().catch((erro) => {
  console.error(erro.message);
  process.exit(1);
});
