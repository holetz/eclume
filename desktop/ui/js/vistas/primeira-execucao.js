// Primeira execução (variante A do DS, frame "First run"): o servidor que o app já conhece — o do
// instalador, o achado na rede ou o digitado em "Avançado" —, a CA fixada pela impressão digital
// (ou conferida pela pessoa, quando o endereço veio sem ela) e a entrada por e-mail e senha ou pelo
// código de pareamento.
import { el, trocar, $ } from "../dom.js";

const ORIGENS = {
  installer: "Veio com este instalador",
  network: "Encontrado na rede",
  typed: "Endereço digitado",
};

/** "eclume em 192.168.15.199": o nome do servidor e o host do endereço. */
export function rotuloDoServidor(servidor) {
  let host = servidor.url;
  try {
    host = new URL(servidor.url).hostname;
  } catch {
    // Endereço fora do formato: mostra como veio.
  }
  const nome = servidor.name && servidor.name !== host ? servidor.name : "eclume";
  return `${nome} em ${host}`;
}

/** O endereço digitado, com o esquema https quando veio só o host; `null` se não serve. */
export function enderecoDigitado(texto) {
  const limpo = texto.trim().replace(/\/+$/, "");
  const url = /^https?:\/\//.test(limpo) ? limpo : `https:\/\/${limpo}`;
  return /^https?:\/\/[^\s/]+$/.test(url) ? url : null;
}

/** A impressão digital em pares de hex separados por ":", para conferir de olho. */
export function impressaoLegivel(hex) {
  return (hex ?? "").toUpperCase().match(/.{1,2}/g)?.join(":") ?? "";
}

export function montar(secao, app) {
  const lista = $("#bv-servidores", secao);
  const aviso = $("#bv-aviso", secao);
  const confianca = $("#bv-confianca", secao);
  const avancado = $("#bv-avancado", secao);
  const botoes = [$("#bv-entrar", secao), $("#bv-parear", secao)];
  let servidores = [];
  let escolhido = null;
  /** O servidor preparado pelo Rust (CA fixada), ou `null`. */
  let preparado = null;
  /** A pessoa já conferiu a impressão digital de um endereço sem ela (TOFU). */
  let confiou = false;
  let ocupado = false;

  function mostrarAviso(texto) {
    aviso.hidden = !texto;
    $("#bv-aviso-texto", aviso).textContent = texto ?? "";
  }

  function podeEntrar() {
    return Boolean(preparado) && (preparado.trusted_by !== "first_use" || confiou) && !ocupado;
  }

  function desenharBotoes() {
    for (const botao of botoes) botao.disabled = !podeEntrar();
  }

  function desenharServidores() {
    trocar(
      lista,
      servidores.map((servidor) =>
        el(
          "label",
          { class: "choice", dataset: { url: servidor.url } },
          el("input", {
            type: "radio",
            name: "servidor",
            value: servidor.url,
            checked: escolhido?.url === servidor.url,
            on: { change: () => escolher(servidor) },
          }),
          el("span", { class: "dot" }),
          el("strong", {}, rotuloDoServidor(servidor)),
          el(
            "small",
            {},
            ORIGENS[servidor.origin] ?? "",
            " · ",
            el("a", { href: "#", on: { click: usarOutro } }, "Usar outro"),
          ),
        ),
      ),
    );
    $("#bv-procurando", secao).hidden = true;
  }

  function usarOutro(evento) {
    evento.preventDefault();
    avancado.open = true;
    $("#bv-endereco", secao).focus();
  }

  function desenharConfianca() {
    const conferir = preparado?.trusted_by === "first_use" && !confiou;
    confianca.hidden = !conferir;
    if (conferir) {
      $("#bv-confianca-servidor", confianca).textContent = rotuloDoServidor(preparado);
      $("#bv-impressao", confianca).textContent = impressaoLegivel(preparado.ca_sha256);
    }
    desenharBotoes();
  }

  async function escolher(servidor) {
    escolhido = servidor;
    preparado = null;
    confiou = false;
    desenharServidores();
    desenharConfianca();
    mostrarAviso(null);
    try {
      preparado = await app.invoke("prepare_server", { url: servidor.url, caSha256: servidor.ca_sha256 ?? null });
    } catch (falha) {
      mostrarAviso(String(falha));
    }
    desenharConfianca();
  }

  async function procurar() {
    $("#bv-procurando", secao).hidden = false;
    $("#bv-procurando", secao).textContent = "Procurando o servidor na rede…";
    try {
      servidores = await app.invoke("discover_servers");
    } catch (falha) {
      servidores = [];
      mostrarAviso(String(falha));
    }
    if (escolhido?.origin === "typed" && !servidores.some((s) => s.url === escolhido.url)) servidores.push(escolhido);
    if (servidores.length === 0) {
      $("#bv-procurando", secao).textContent = "Nenhum servidor na rede. Digite o endereço em Avançado.";
      avancado.open = true;
      return;
    }
    desenharServidores();
    await escolher(servidores.find((s) => s.url === escolhido?.url) ?? servidores[0]);
  }

  async function entrarCom(comando, args) {
    if (!podeEntrar()) return;
    ocupado = true;
    desenharBotoes();
    mostrarAviso(null);
    try {
      await app.invoke(comando, args);
      $("#bv-senha", secao).value = "";
      $("#bv-codigo", secao).value = "";
      await app.atualizar();
      app.voltar();
    } catch (falha) {
      mostrarAviso(String(falha));
    } finally {
      ocupado = false;
      desenharBotoes();
    }
  }

  $("#bv-entrar-form", secao).addEventListener("submit", (evento) => {
    evento.preventDefault();
    entrarCom("sign_in", { email: $("#bv-email", secao).value.trim(), password: $("#bv-senha", secao).value });
  });
  $("#bv-parear", secao).addEventListener("click", () => {
    const codigo = $("#bv-codigo", secao).value.trim();
    if (!codigo) {
      mostrarAviso("Digite o código de 6 caracteres mostrado na web.");
      return;
    }
    entrarCom("pair", { code: codigo });
  });
  $("#bv-confiar", secao).addEventListener("click", () => {
    confiou = true;
    desenharConfianca();
  });
  $("#bv-usar-endereco", secao).addEventListener("click", () => {
    const url = enderecoDigitado($("#bv-endereco", secao).value);
    if (!url) {
      mostrarAviso("Endereço inválido: digite o host do servidor, com ou sem https.");
      return;
    }
    const digitado = { name: "", url, ca_sha256: null, origin: "typed" };
    servidores = [...servidores.filter((s) => s.url !== url), digitado];
    escolher(digitado);
  });
  $("#bv-procurar", secao).addEventListener("click", (evento) => {
    evento.preventDefault();
    procurar();
  });
  $("#bv-cadastro", secao).addEventListener("click", async (evento) => {
    evento.preventDefault();
    const url = preparado?.url ?? escolhido?.url;
    if (!url) {
      mostrarAviso("Escolha o servidor antes de criar a conta.");
      return;
    }
    try {
      await app.invoke("open_signup", { url });
    } catch (falha) {
      mostrarAviso(String(falha));
    }
  });
  $("#bv-voltar", secao).addEventListener("click", () => app.voltar());

  return {
    entrar() {
      mostrarAviso(null);
      desenharBotoes();
      procurar();
    },

    atualizar(estado) {
      // Quem já sincroniza (PAT antigo) chega aqui por "Entrar com e-mail e senha" e pode voltar.
      $("#bv-voltar", secao).hidden = estado.connection === "first_run";
      if (estado.connection === "first_run" && estado.sync_notice && aviso.hidden) {
        mostrarAviso(estado.sync_notice);
      }
    },
  };
}
