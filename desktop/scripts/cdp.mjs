#!/usr/bin/env node
// Talks to the real desktop app window through the WebView2 CDP (or WebKitGTK/Chromium with the
// debugging port open), with no dependency: Node 22's native `WebSocket`.
//
//   node desktop/scripts/cdp.mjs eval "<expression>"    evaluates in the window (with awaitPromise)
//                                                        and prints the result as JSON
//   node desktop/scripts/cdp.mjs screenshot window.png  saves a screenshot of the window
//
// The port comes from CDP_PORT (default 9229), the one in docs/project/estacao-windows.md: the app
// must have opened with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9229".
import { writeFile } from "node:fs/promises";

const PORT = Number(process.env.CDP_PORT ?? 9229);
const [command, argument] = process.argv.slice(2);

function usage() {
  console.error('usage: node desktop/scripts/cdp.mjs eval "<expression>" | screenshot <file.png>');
  process.exit(2);
}

/** The WebSocket address of the eclume window (the first page, if the title does not match). */
async function target() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`).catch((error) => {
    throw new Error(`no window with CDP at 127.0.0.1:${PORT} (${error.cause?.code ?? error.message})`);
  });
  const pages = (await response.json()).filter((t) => t.type === "page");
  const page = pages.find((t) => t.title === "eclume") ?? pages[0];
  if (!page) throw new Error(`no page at 127.0.0.1:${PORT}`);
  return page.webSocketDebuggerUrl;
}

/** Opens the connection and returns `send(method, params)`, which resolves with the CDP `result`. */
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error(`failed to connect to ${url}`)), { once: true });
  });
  let next = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      next += 1;
      pending.set(next, { resolve, reject });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  return { send, close: () => ws.close() };
}

async function main() {
  if (!argument || !["eval", "screenshot"].includes(command)) usage();
  const { send, close } = await connect(await target());
  try {
    if (command === "eval") {
      const { result, exceptionDetails } = await send("Runtime.evaluate", {
        expression: argument,
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails) {
        throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      }
      console.log(JSON.stringify(result.value ?? null, null, 2));
    } else {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(argument, Buffer.from(data, "base64"));
      console.log(argument);
    }
  } finally {
    close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
