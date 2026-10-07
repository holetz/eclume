"""Anúncio mDNS `_eclume._tcp`: o registro, o TXT e a atualização quando a CA muda. Sem rede."""

from __future__ import annotations

import asyncio
import os
import shutil
import socket
from pathlib import Path
from typing import Any

import pytest

from eclume_server.config import Settings
from eclume_server.contract import CONTRACT_VERSION
from eclume_server.discovery import SERVICE_TYPE, Announcer, DiscoveryError, describe, endpoint, service_info

CA = Path(__file__).parent / "fixtures" / "ca-teste.pem"
CA_SHA256 = "b127358a576a7cd0e4d76b63271e80a7d168a412e635e10855fcde3f83a4dd20"


def _settings(**values: Any) -> Settings:  # noqa: ANN401
    return Settings(**{"public_url": "https://192.168.15.199:8443/", "server_name": "eclume"} | values)


def test_registro_usa_o_endereco_publico_e_o_txt_da_ca():
    info = service_info(_settings(), CA_SHA256)
    assert info.type == SERVICE_TYPE == "_eclume._tcp.local."
    assert info.name == "eclume._eclume._tcp.local."
    assert info.server == "eclume.local."
    assert (info.parsed_addresses(), info.port) == (["192.168.15.199"], 8443)
    assert describe(info) == {
        "name": "eclume",
        "url": "https://192.168.15.199:8443",
        "ca_sha256": CA_SHA256,
        "contract_version": CONTRACT_VERSION,
        "addresses": ["192.168.15.199"],
        "port": 8443,
    }
    assert describe(service_info(_settings(server_name="sala-2"), None))["ca_sha256"] is None


def test_endereco_publico_obrigatorio_e_porta_padrao(monkeypatch: pytest.MonkeyPatch):
    with pytest.raises(DiscoveryError):
        endpoint(_settings(public_url=None))
    assert endpoint(_settings(public_url="https://10.0.0.5")) == ("https://10.0.0.5", "10.0.0.5", 443)
    monkeypatch.setattr(socket, "gethostbyname", lambda host: {"eclume.lan": "10.0.0.9"}[host])
    assert endpoint(_settings(public_url="http://eclume.lan:8080/")) == ("http://eclume.lan:8080", "10.0.0.9", 8080)


class FakeZeroconf:
    """O `AsyncZeroconf` sem rede: guarda o que foi anunciado."""

    def __init__(self) -> None:
        """Sem chamadas ainda."""
        self.calls: list[tuple[str, dict[str, str]]] = []

    async def _record(self, action: str, info: Any) -> asyncio.Future[None]:  # noqa: ANN401
        self.calls.append((action, {k.decode(): (v or b"").decode() for k, v in info.properties.items()}))
        done: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        done.set_result(None)
        return done

    async def async_register_service(self, info: Any) -> asyncio.Future[None]:  # noqa: ANN401, D102
        return await self._record("register", info)

    async def async_update_service(self, info: Any) -> asyncio.Future[None]:  # noqa: ANN401, D102
        return await self._record("update", info)

    async def async_unregister_service(self, info: Any) -> asyncio.Future[None]:  # noqa: ANN401, D102
        return await self._record("unregister", info)


def test_anuncio_atualiza_o_txt_quando_a_ca_e_publicada(tmp_path: Path):
    ca = tmp_path / "eclume-root.crt"
    zeroconf = FakeZeroconf()
    announcer = Announcer(_settings(ca_file=str(ca)), zeroconf)  # type: ignore[arg-type]

    async def scenario() -> list[bool]:
        await announcer.start()
        unchanged = await announcer.refresh()
        shutil.copyfile(CA, ca)
        stat = ca.stat()
        os.utime(ca, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
        published = await announcer.refresh()
        again = await announcer.refresh()
        await announcer.stop()
        return [unchanged, published, again]

    assert asyncio.run(scenario()) == [False, True, False]
    assert [(action, txt["ca"]) for action, txt in zeroconf.calls] == [
        ("register", ""),
        ("update", CA_SHA256),
        ("unregister", CA_SHA256),
    ]
