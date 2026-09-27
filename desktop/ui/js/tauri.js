// Único ponto de contato com o Tauri. A API global (`withGlobalTauri`) é lida a cada chamada, e
// não na carga do módulo, para os testes de navegador injetarem o mock antes.

export function invoke(comando, args) {
  return window.__TAURI__.core.invoke(comando, args);
}

export function listen(evento, handler) {
  return window.__TAURI__.event.listen(evento, handler);
}
