"""The account's product locale: `GET`/`PATCH /me/locale`.

Reading accepts any valid credential, with no scope (like `/me`); writing, only the session. A null
`locale` means no choice: the request resolves `Accept-Language`, then `en`. Rules in
docs/standards/code/i18n.md.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy import update

from eclume_server import locale as product_locale
from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db import tables as t
from eclume_server.db.session import user_tx

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires())]
Member = Annotated[Principal, Depends(requires(session_only=True))]


class AccountLocalePatch(BaseModel):
    """Body of `PATCH /me/locale`: a null `locale` drops the choice."""

    model_config = ConfigDict(extra="forbid")

    locale: product_locale.Locale | None


async def _locale_json(conn: AsyncConnection, user_id: UUID, request: Request) -> dict[str, Any]:
    """Schema `AccountLocale`."""
    chosen = await product_locale.account_locale(conn, user_id)
    return {
        "locale": chosen,
        "effective": product_locale.resolve(chosen, request.headers.get("accept-language")),
        "default": product_locale.DEFAULT,
        "supported": list(product_locale.SUPPORTED),
    }


@router.get("/me/locale")
async def get_account_locale(principal: Reader, request: Request, ctx: Ctx) -> dict[str, Any]:
    """The account's locale, the one in force for this request, the default and the supported ones."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await _locale_json(conn, principal.user_id, request)


@router.patch("/me/locale")
async def patch_account_locale(
    body: AccountLocalePatch, principal: Member, request: Request, ctx: Ctx
) -> dict[str, Any]:
    """Change the account's locale; summaries and agent answers generated from now on follow it."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await conn.execute(update(t.users).where(t.users.c.id == principal.user_id).values(locale=body.locale))
        return await _locale_json(conn, principal.user_id, request)
