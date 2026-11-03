"""The product locales and how one is resolved for a request, an account or a job.

`en` is the default and `pt-BR` the second locale. A request resolves the account's `users.locale`,
then `Accept-Language`, then `en`; a job, which has no request, resolves the owner's account locale,
then `en`. The ASR language is a separate setting (`/me/transcription`). Rules in
docs/standards/code/i18n.md.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from sqlalchemy import select

from eclume_server.db import tables as t

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

Locale = Literal["en", "pt-BR"]

DEFAULT: Locale = "en"
SUPPORTED: tuple[Locale, ...] = ("en", "pt-BR")
_BY_LANGUAGE: dict[str, Locale] = {"en": "en", "pt": "pt-BR"}


def normalize(tag: str | None) -> Locale | None:
    """The supported locale a BCP 47 tag maps to (`pt`, `pt-PT` → `pt-BR`; `en-US` → `en`), or None."""
    if not tag:
        return None
    language = tag.strip().replace("_", "-").split("-", 1)[0].lower()
    return _BY_LANGUAGE.get(language)


def parse_accept_language(header: str | None) -> Locale | None:
    """The first supported locale of an `Accept-Language` header, by `q` weight; None when none matches."""
    if not header:
        return None
    ranked: list[tuple[float, int, str]] = []
    for position, item in enumerate(header.split(",")):
        tag, *params = (part.strip() for part in item.split(";"))
        weight = 1.0
        for param in params:
            name, _, value = param.partition("=")
            if name.strip().lower() == "q":
                try:
                    weight = float(value)
                except ValueError:
                    weight = 0.0
        if tag and weight > 0:
            ranked.append((-weight, position, tag))
    for _, _, tag in sorted(ranked):
        locale = normalize(tag)
        if locale is not None:
            return locale
    return None


def resolve(account_locale: str | None, accept_language: str | None = None) -> Locale:
    """The locale in force: the account's, else the `Accept-Language` one, else the default."""
    return normalize(account_locale) or parse_accept_language(accept_language) or DEFAULT


async def account_locale(conn: AsyncConnection, user_id: UUID) -> Locale | None:
    """The account's stored locale; None when it never chose one."""
    value = (await conn.execute(select(t.users.c.locale).where(t.users.c.id == user_id))).scalar()
    return normalize(value)


async def job_locale(conn: AsyncConnection, owner_id: UUID) -> Locale:
    """The locale of a job, which has no request: the owner's account locale, else the default."""
    return await account_locale(conn, owner_id) or DEFAULT
