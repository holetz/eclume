"""Anúncio e descoberta do servidor na rede local por mDNS (`_eclume._tcp`).

O anúncio usa o endereço de `ECLUME_PUBLIC_URL`, e não os IPs das interfaces: no host, o serviço
`mdns` roda na rede do host, onde as bridges do Docker também são interfaces. O TXT traz o que o
app precisa para fixar a CA antes da primeira requisição (docs/standards/code/server-mcp-e-dispositivos.md).
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from zeroconf import ServiceInfo, ServiceStateChange
from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf

from eclume_server.routes.auth import CONTRACT_VERSION
from eclume_server.server_info import ca_sha256

if TYPE_CHECKING:
    from zeroconf import Zeroconf

    from eclume_server.config import Settings

SERVICE_TYPE = "_eclume._tcp.local."
REFRESH_SECONDS = 60


class DiscoveryError(ValueError):
    """Configuração que não dá para anunciar."""


def endpoint(settings: Settings) -> tuple[str, str, int]:
    """URL pública sem barra final, o IPv4 dela e a porta."""
    if not settings.public_url:
        msg = "defina ECLUME_PUBLIC_URL: o anúncio usa o endereço público, não o das interfaces"
        raise DiscoveryError(msg)
    url = settings.public_url.rstrip("/")
    parts = urlsplit(url)
    if not parts.hostname:
        msg = f"ECLUME_PUBLIC_URL sem host: {url}"
        raise DiscoveryError(msg)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        address = str(ipaddress.IPv4Address(parts.hostname))
    except ValueError:
        address = socket.gethostbyname(parts.hostname)
    return url, address, port


def service_info(settings: Settings, ca: str | None) -> ServiceInfo:
    """O registro anunciado: instância `<ECLUME_SERVER_NAME>`, TXT `url`, `ca`, `v` e `name`."""
    url, address, port = endpoint(settings)
    name = settings.server_name
    return ServiceInfo(
        SERVICE_TYPE,
        f"{name}.{SERVICE_TYPE}",
        addresses=[socket.inet_aton(address)],
        port=port,
        properties={"url": url, "ca": ca or "", "v": CONTRACT_VERSION, "name": name},
        server=f"{name}.local.",
    )


def describe(info: ServiceInfo) -> dict[str, Any]:
    """Um servidor achado: o TXT decodificado, os endereços e a porta."""
    txt = {key.decode(): (value or b"").decode() for key, value in info.properties.items()}
    return {
        "name": txt.get("name") or info.name.removesuffix(f".{SERVICE_TYPE}"),
        "url": txt.get("url"),
        "ca_sha256": txt.get("ca") or None,
        "contract_version": txt.get("v"),
        "addresses": info.parsed_addresses(),
        "port": info.port,
    }


class Announcer:
    """Mantém o anúncio: registra, e atualiza o TXT quando a CA publicada muda."""

    def __init__(self, settings: Settings, zeroconf: AsyncZeroconf) -> None:
        """O anúncio de `settings` no `zeroconf` dado."""
        self.settings = settings
        self.zeroconf = zeroconf
        self.ca = ca_sha256(settings.ca_file)
        self.info = service_info(settings, self.ca)

    async def start(self) -> None:
        """Registra o serviço na rede."""
        await (await self.zeroconf.async_register_service(self.info))

    async def refresh(self) -> bool:
        """Relê a CA; se mudou (inclusive publicada depois), anuncia o TXT novo."""
        ca = ca_sha256(self.settings.ca_file)
        if ca == self.ca:
            return False
        self.ca, self.info = ca, service_info(self.settings, ca)
        await (await self.zeroconf.async_update_service(self.info))
        return True

    async def stop(self) -> None:
        """Retira o anúncio (os goodbyes do mDNS)."""
        await (await self.zeroconf.async_unregister_service(self.info))


async def announce(settings: Settings, *, refresh_seconds: float = REFRESH_SECONDS) -> None:
    """Anuncia até ser interrompido, relendo a CA a cada `refresh_seconds`."""
    _, address, _ = endpoint(settings)
    zeroconf = AsyncZeroconf(interfaces=[address])
    announcer = Announcer(settings, zeroconf)
    await announcer.start()
    print(f"anunciando {announcer.info.name} em {address}:{announcer.info.port}", flush=True)  # noqa: T201
    try:
        while True:
            await asyncio.sleep(refresh_seconds)
            if await announcer.refresh():
                print(f"CA nova no anúncio: {announcer.ca}", flush=True)  # noqa: T201
    finally:
        await announcer.stop()
        await zeroconf.async_close()


async def discover(listen_seconds: float) -> list[dict[str, Any]]:
    """Os servidores `_eclume._tcp` que respondem na rede em `listen_seconds` segundos."""
    names: set[str] = set()

    def on_change(zeroconf: Zeroconf, service_type: str, name: str, state_change: ServiceStateChange) -> None:
        del zeroconf, service_type
        if state_change is not ServiceStateChange.Removed:
            names.add(name)

    zeroconf = AsyncZeroconf()
    browser = AsyncServiceBrowser(zeroconf.zeroconf, SERVICE_TYPE, handlers=[on_change])
    try:
        await asyncio.sleep(listen_seconds)
        found = []
        for name in sorted(names):
            info = AsyncServiceInfo(SERVICE_TYPE, name)
            if await info.async_request(zeroconf.zeroconf, 3000):
                found.append(describe(info))
        return found
    finally:
        await browser.async_cancel()
        await zeroconf.async_close()
