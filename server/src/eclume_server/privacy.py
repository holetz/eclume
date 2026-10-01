"""Para onde vai cada dado: a classificação do destino da transcrição e de cada finalidade de agente.

O servidor classifica e os clientes só mostram (holetz/eclume#116). Na dúvida, "fora": errar para
fora só sobra-avisa, errar para dentro esconderia o envio. Sem resolver DNS.
"""

from __future__ import annotations

import ipaddress
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from sqlalchemy import select

from eclume_server.db import tables as t
from eclume_server.summaries import PURPOSES, provider_for

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncConnection

SERVER, LOCAL_NETWORK, EXTERNAL, DISABLED = "server", "local_network", "external", "disabled"
# Tipos de provider que sempre mandam o texto à Anthropic.
_ANTHROPIC_KINDS = {"anthropic", "claude-cli"}
# O próprio host visto de dentro de um contêiner.
_THIS_HOST = {"localhost", "host.docker.internal"}
_LOCAL_SUFFIXES = (".local", ".lan")
_LOCAL_NETWORKS = [
    ipaddress.ip_network(net)
    for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "fe80::/10", "fc00::/7")
]


def _location(host: str) -> str:
    """Destino de um host já normalizado; o que não se prova dentro fica fora."""
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if host in _THIS_HOST or "." not in host:
            return SERVER
        return LOCAL_NETWORK if host.endswith(_LOCAL_SUFFIXES) else EXTERNAL
    if address.is_loopback:
        return SERVER
    return LOCAL_NETWORK if any(address in net for net in _LOCAL_NETWORKS) else EXTERNAL


def classify_url(url: str | None) -> tuple[str, str | None]:
    """`(destino, quem processa)` de um endereço; fora do servidor, quem processa é só o host."""
    host = (urlsplit(url or "").hostname or "").rstrip(".").lower()
    if not host:
        return EXTERNAL, None
    location = _location(host)
    return location, host if location == EXTERNAL else None


def classify_provider(kind: str, base_url: str | None) -> tuple[str, str | None]:
    """Destino de um provider de agente pelo tipo e pelo endereço."""
    if kind in _ANTHROPIC_KINDS:
        return EXTERNAL, "Anthropic"
    return classify_url(base_url)


def classify_asr(asr: dict[str, Any]) -> tuple[str, str | None]:
    """Destino da transcrição: a engine local (GPU ou CPU) fica no servidor; a remota segue o endereço."""
    if asr.get("engine") == "openai-compatible":
        return classify_url(asr.get("endpoint_url"))
    return SERVER, None


def _destination(purpose: str, where: tuple[str, str | None]) -> dict[str, Any]:
    return {"purpose": purpose, "location": where[0], "processor": where[1]}


async def privacy_info(conn: AsyncConnection) -> dict[str, Any]:
    """Schema `PrivacyInfo`: um destino por finalidade, sem endereço, modelo, chave nem nome."""
    asr = (await conn.execute(select(t.platform_settings.c.asr))).scalar_one()
    destinations = [_destination("transcription", classify_asr(asr or {}))]
    for purpose in PURPOSES:
        provider = await provider_for(conn, purpose)
        where = (DISABLED, None) if provider is None else classify_provider(provider["kind"], provider["base_url"])
        destinations.append(_destination(purpose, where))
    return {"destinations": destinations}
