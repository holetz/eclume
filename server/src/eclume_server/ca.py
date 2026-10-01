"""Raiz própria do eclume com restrição de nome (`eclume-server ca gerar`).

A chave fica no host para o Caddy emitir intermediários e folhas sozinho; a restrição de nome
crítica limita o estrago de quem a roubar a se passar pelo próprio servidor
(docs/standards/code/server-mcp-e-dispositivos.md §Fixação da CA).
"""

from __future__ import annotations

import hashlib
import ipaddress
import os
import re
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

if TYPE_CHECKING:
    from pathlib import Path

ROOT_CERT = "raiz.crt"
ROOT_KEY = "raiz.key"
ROOT_LIFETIME = timedelta(days=3650)
# Sem subtree de um tipo, nomes desse tipo ficam livres (RFC 5280): DNS e e-mail entram sempre,
# com um nome reservado que não resolve quando a instalação não usa nenhum.
UNUSED_DOMAIN = "eclume.invalid"
# Raiz descartável da prova nos clientes: aceita o primeiro endereço e recusa o segundo.
PROOF_INSIDE = "127.0.0.1"
PROOF_OUTSIDE = "127.0.0.2"
PROOF_LIFETIME = timedelta(days=30)
_BACKDATE = timedelta(minutes=5)


class CaError(Exception):
    """Falha da geração, com mensagem para o operador."""


def _ip_network(value: str) -> ipaddress.IPv4Network | ipaddress.IPv6Network | None:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return None
    return ipaddress.ip_network(address)  # /32 ou /128


def permitted_names(host: str, names: list[str]) -> list[x509.GeneralName]:
    """Subtrees permitidas: cada IP exato e cada nome DNS de `host` e `names`, mais o e-mail inútil."""
    ips: list[x509.GeneralName] = []
    dns: list[x509.GeneralName] = []
    for value in dict.fromkeys(v.strip().lower() for v in [host, *names] if v.strip()):
        network = _ip_network(value)
        if network is not None:
            ips.append(x509.IPAddress(network))
        else:
            dns.append(x509.DNSName(value))
    if not ips:
        raise CaError("a raiz precisa de um IP permitido (ECLUME_PUBLIC_HOST ou ECLUME_CA_NOMES)")
    return [*ips, *(dns or [x509.DNSName(UNUSED_DOMAIN)]), x509.RFC822Name(UNUSED_DOMAIN)]


def split_names(raw: str | None) -> list[str]:
    """`ECLUME_CA_NOMES`: nomes ou IPs separados por vírgula ou espaço."""
    return [n for n in re.split(r"[,\s]+", raw or "") if n]


def _root(key: ec.EllipticCurvePrivateKey, permitted: list[x509.GeneralName], now: datetime) -> x509.Certificate:
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "eclume CA raiz")])
    return (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - _BACKDATE)
        .not_valid_after(now + ROOT_LIFETIME)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.NameConstraints(permitted_subtrees=permitted, excluded_subtrees=None), critical=True)
        # Na raiz, para o Windows não aceitá-la em assinatura de código nem S/MIME.
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )


def _leaf(root: x509.Certificate, root_key: ec.EllipticCurvePrivateKey, ip: str, now: datetime) -> tuple[bytes, bytes]:
    key = ec.generate_private_key(ec.SECP256R1())
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, ip)]))
        .issuer_name(root.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - _BACKDATE)
        .not_valid_after(now + PROOF_LIFETIME)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address(ip))]), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()), critical=False)
        .sign(root_key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.PEM), _key_pem(key)


def _key_pem(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )


def _write_private(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as out:
        out.write(data)


def sha256(cert: x509.Certificate) -> str:
    """Impressão digital no formato do descritor (`ca_sha256`)."""
    return hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest()


def generate(folder: Path, host: str, names: list[str], now: datetime | None = None) -> x509.Certificate:
    """Cria `raiz.crt` e `raiz.key` em `folder`; recusa sobrescrever uma raiz que já existe."""
    cert_path, key_path = folder / ROOT_CERT, folder / ROOT_KEY
    existing = [p.name for p in (cert_path, key_path) if p.exists()]
    if existing:
        raise CaError(f"{folder} já tem {', '.join(existing)}; a raiz não é sobrescrita")
    permitted = permitted_names(host, names)
    folder.mkdir(parents=True, exist_ok=True)
    key = ec.generate_private_key(ec.SECP256R1())
    root = _root(key, permitted, now or datetime.now(UTC))
    _write_private(key_path, _key_pem(key))
    cert_path.write_bytes(root.public_bytes(serialization.Encoding.PEM))
    return root


def generate_proof(folder: Path, now: datetime | None = None) -> x509.Certificate:
    """Raiz descartável de `127.0.0.1` e os folhas `dentro` (127.0.0.1) e `fora` (127.0.0.2).

    A chave da raiz não é gravada: a prova só serve para os clientes aceitarem um e recusarem o outro.
    """
    now = now or datetime.now(UTC)
    folder.mkdir(parents=True, exist_ok=True)
    key = ec.generate_private_key(ec.SECP256R1())
    root = _root(key, permitted_names(PROOF_INSIDE, []), now)
    (folder / ROOT_CERT).write_bytes(root.public_bytes(serialization.Encoding.PEM))
    for stem, ip in (("dentro", PROOF_INSIDE), ("fora", PROOF_OUTSIDE)):
        cert_pem, key_pem = _leaf(root, key, ip, now)
        (folder / f"{stem}.crt").write_bytes(cert_pem)
        (folder / f"{stem}.key").unlink(missing_ok=True)
        _write_private(folder / f"{stem}.key", key_pem)
    return root
