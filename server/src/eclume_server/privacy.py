"""Where each piece of data goes: the destination classification of transcription and of each agent purpose.

The server classifies and the clients only display (holetz/eclume#116). When in doubt, "external":
erring outward only over-warns, erring inward would hide the transfer. No DNS resolution.
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
# Provider kinds that always send the text to Anthropic.
_ANTHROPIC_KINDS = {"anthropic", "claude-cli"}
# The host itself as seen from inside a container.
_THIS_HOST = {"localhost", "host.docker.internal"}
_LOCAL_SUFFIXES = (".local", ".lan")
_LOCAL_NETWORKS = [
    ipaddress.ip_network(net)
    for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "fe80::/10", "fc00::/7")
]


def _location(host: str) -> str:
    """Destination of an already normalized host; whatever is not proven inside is external."""
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
    """`(destination, processor)` of an address; outside the server, the processor is just the host."""
    host = (urlsplit(url or "").hostname or "").rstrip(".").lower()
    if not host:
        return EXTERNAL, None
    location = _location(host)
    return location, host if location == EXTERNAL else None


def classify_provider(kind: str, base_url: str | None) -> tuple[str, str | None]:
    """Destination of an agent provider by its kind and address."""
    if kind in _ANTHROPIC_KINDS:
        return EXTERNAL, "Anthropic"
    return classify_url(base_url)


def classify_asr(asr: dict[str, Any]) -> tuple[str, str | None]:
    """Destination of transcription: the local engine (GPU or CPU) stays on the server; a remote one follows its address."""
    if asr.get("engine") == "openai-compatible":
        return classify_url(asr.get("endpoint_url"))
    return SERVER, None


def _destination(purpose: str, where: tuple[str, str | None]) -> dict[str, Any]:
    return {"purpose": purpose, "location": where[0], "processor": where[1]}


async def privacy_info(conn: AsyncConnection) -> dict[str, Any]:
    """Schema `PrivacyInfo`: one destination per purpose, with no address, model, key or name."""
    asr = (await conn.execute(select(t.platform_settings.c.asr))).scalar_one()
    destinations = [_destination("transcription", classify_asr(asr or {}))]
    for purpose in PURPOSES:
        provider = await provider_for(conn, purpose)
        where = (DISABLED, None) if provider is None else classify_provider(provider["kind"], provider["base_url"])
        destinations.append(_destination(purpose, where))
    return {"destinations": destinations}
