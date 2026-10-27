"""Announcement and discovery of the server on the local network over mDNS (`_eclume._tcp`).

The announcement uses the address of `ECLUME_PUBLIC_URL`, not the interfaces' IPs: on the host, the
`mdns` service runs on the host network, where the Docker bridges are interfaces too. The TXT carries
what the app needs to pin the CA before the first request (docs/standards/code/server-mcp-e-dispositivos.md).
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from zeroconf import ServiceInfo, ServiceStateChange
from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf

from eclume_server.contract import CONTRACT_VERSION
from eclume_server.server_info import ca_sha256

if TYPE_CHECKING:
    from zeroconf import Zeroconf

    from eclume_server.config import Settings

SERVICE_TYPE = "_eclume._tcp.local."
REFRESH_SECONDS = 60


class DiscoveryError(ValueError):
    """Configuration that cannot be announced."""


def endpoint(settings: Settings) -> tuple[str, str, int]:
    """Public URL without a trailing slash, its IPv4 and the port."""
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
    """The announced record: instance `<ECLUME_SERVER_NAME>`, TXT `url`, `ca`, `v` and `name`."""
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
    """A server found: the decoded TXT, the addresses and the port."""
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
    """Keep the announcement: register, and update the TXT when the published CA changes."""

    def __init__(self, settings: Settings, zeroconf: AsyncZeroconf) -> None:
        """The announcement of `settings` on the given `zeroconf`."""
        self.settings = settings
        self.zeroconf = zeroconf
        self.ca = ca_sha256(settings.ca_file)
        self.info = service_info(settings, self.ca)

    async def start(self) -> None:
        """Register the service on the network."""
        await (await self.zeroconf.async_register_service(self.info))

    async def refresh(self) -> bool:
        """Re-read the CA; if it changed (including published later), announce the new TXT."""
        ca = ca_sha256(self.settings.ca_file)
        if ca == self.ca:
            return False
        self.ca, self.info = ca, service_info(self.settings, ca)
        await (await self.zeroconf.async_update_service(self.info))
        return True

    async def stop(self) -> None:
        """Withdraw the announcement (the mDNS goodbyes)."""
        await (await self.zeroconf.async_unregister_service(self.info))


async def announce(settings: Settings, *, refresh_seconds: float = REFRESH_SECONDS) -> None:
    """Announce until interrupted, re-reading the CA every `refresh_seconds`."""
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
    """The `_eclume._tcp` servers that answer on the network within `listen_seconds` seconds."""
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
