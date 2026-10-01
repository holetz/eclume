"""Raiz própria com restrição de nome: perfil, recusa de sobrescrever e a prova dentro/fora."""

from __future__ import annotations

import ipaddress
from typing import TYPE_CHECKING

import pytest
from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID
from cryptography.x509.verification import PolicyBuilder, Store, VerificationError

from eclume_server import cli
from eclume_server.ca import CaError, generate, permitted_names, split_names

if TYPE_CHECKING:
    from pathlib import Path


def _verify(root: x509.Certificate, leaf: x509.Certificate, ip: str) -> None:
    subject = x509.IPAddress(ipaddress.ip_address(ip))
    PolicyBuilder().store(Store([root])).build_server_verifier(subject).verify(leaf, [])


def _load(path: Path) -> x509.Certificate:
    return x509.load_pem_x509_certificate(path.read_bytes())


def test_perfil_da_raiz(tmp_path: Path):
    root = generate(tmp_path, "192.168.15.199", ["holetz-pc.local"])

    assert isinstance(root.public_key(), ec.EllipticCurvePublicKey)
    assert root.public_key().curve.name == "secp256r1"
    assert (root.not_valid_after_utc - root.not_valid_before_utc).days >= 3650
    constraints = root.extensions.get_extension_for_class(x509.NameConstraints)
    assert constraints.critical
    assert constraints.value.permitted_subtrees == [
        x509.IPAddress(ipaddress.ip_network("192.168.15.199/32")),
        x509.DNSName("holetz-pc.local"),
        x509.RFC822Name("eclume.invalid"),
    ]
    assert constraints.value.excluded_subtrees is None
    eku = root.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
    assert list(eku) == [ExtendedKeyUsageOID.SERVER_AUTH]
    assert root.extensions.get_extension_for_class(x509.BasicConstraints).value.ca
    key = (tmp_path / "raiz.key").read_bytes()
    assert b"PRIVATE KEY" in key
    assert _load(tmp_path / "raiz.crt") == root


def test_sem_nome_dns_restringe_dns_ao_dominio_inutil():
    assert permitted_names("10.0.0.5", []) == [
        x509.IPAddress(ipaddress.ip_network("10.0.0.5/32")),
        x509.DNSName("eclume.invalid"),
        x509.RFC822Name("eclume.invalid"),
    ]


def test_sem_ip_recusa():
    with pytest.raises(CaError, match="IP permitido"):
        permitted_names("holetz-pc.local", [])


def test_nomes_por_virgula_ou_espaco():
    assert split_names(" holetz-pc.local, 10.0.0.6  eclume.lan ") == ["holetz-pc.local", "10.0.0.6", "eclume.lan"]
    assert split_names(None) == []


def test_recusa_sobrescrever(tmp_path: Path):
    generate(tmp_path, "192.168.15.199", [])
    before = (tmp_path / "raiz.crt").read_bytes()
    with pytest.raises(CaError, match="não é sobrescrita"):
        generate(tmp_path, "192.168.15.199", [])
    assert (tmp_path / "raiz.crt").read_bytes() == before


def test_prova_aceita_dentro_e_recusa_fora(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    assert cli.main(["ca", "gerar", "--prova", str(tmp_path)]) == 0
    assert "sha256 " in capsys.readouterr().out

    root = _load(tmp_path / "raiz.crt")
    assert not (tmp_path / "raiz.key").exists()
    _verify(root, _load(tmp_path / "dentro.crt"), "127.0.0.1")
    with pytest.raises(VerificationError, match="name constraint"):
        _verify(root, _load(tmp_path / "fora.crt"), "127.0.0.2")
    for stem in ("dentro", "fora"):
        assert b"PRIVATE KEY" in (tmp_path / f"{stem}.key").read_bytes()


def test_prova_pode_ser_refeita(tmp_path: Path):
    assert cli.main(["ca", "gerar", "--prova", str(tmp_path)]) == 0
    assert cli.main(["ca", "gerar", "--prova", str(tmp_path)]) == 0


def test_cli_gerar_e_recusa(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    folder = tmp_path / "secrets" / "ca"
    args = ["ca", "gerar", "--pasta", str(folder), "--host", "192.168.15.199", "--nomes", "holetz-pc.local"]
    assert cli.main(args) == 0
    assert capsys.readouterr().out.startswith("sha256 ")
    assert cli.main(args) == 2
    assert "não é sobrescrita" in capsys.readouterr().err
