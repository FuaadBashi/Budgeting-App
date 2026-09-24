"""Bank connections: consent, account mapping, and sync into the inbox.

Every route that would contact a bank goes through `bank_sync.build_provider()`,
which is the disabled provider unless BANK_SYNC_PROVIDER and its credentials
are all set. With it disabled, each route refuses with the reason rather than
failing somewhere less legible.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import to_minor
from app.config import settings
from app.db import get_session
from app.domain import bank_sync, clock, importing
from app.domain.clock import today as clock_today
from app.models import BankConnection, BankConnectionStatus, BankLink

router = APIRouter()


class BankStatusOut(BaseModel):
    enabled: bool
    provider: str
    country: str
    redirect_url: str


class BankOut(BaseModel):
    name: str
    country: str
    logo: str | None


class ConnectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bank: str = Field(min_length=1, max_length=120)
    country: str | None = Field(default=None, min_length=2, max_length=2)


class ConnectOut(BaseModel):
    connection_id: uuid.UUID
    #: The bank's consent page. The client sends the person here.
    url: str


class CallbackIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(min_length=1, max_length=2000)
    state: str = Field(min_length=1, max_length=64)


class LinkOut(BaseModel):
    id: uuid.UUID
    name: str
    identifier: str | None
    currency: str
    account_id: uuid.UUID | None
    last_synced_at: datetime | None
    synced_through: date | None
    bank_balance_minor: int | None
    bank_balance_at: datetime | None


class ConnectionOut(BaseModel):
    id: uuid.UUID
    bank: str
    country: str
    status: BankConnectionStatus
    valid_until: datetime | None
    links: list[LinkOut]


class LinkEditIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_id: uuid.UUID | None


class SyncOut(BaseModel):
    staged: int
    already_seen: int
    pending_skipped: int
    foreign_skipped: int
    batch_id: uuid.UUID | None


def _refuse(exc: bank_sync.BankSyncError) -> HTTPException:
    return HTTPException(status_code=422, detail=str(exc))


def _connection_out(c: BankConnection) -> ConnectionOut:
    return ConnectionOut(
        id=c.id,
        bank=c.aspsp_name,
        country=c.aspsp_country,
        status=c.status,
        valid_until=c.valid_until,
        links=[
            LinkOut(
                id=link.id,
                name=link.name,
                identifier=link.identifier,
                currency=link.currency,
                account_id=link.account_id,
                last_synced_at=link.last_synced_at,
                synced_through=link.synced_through,
                bank_balance_minor=to_minor(link.bank_balance) if link.bank_balance is not None else None,
                bank_balance_at=link.bank_balance_at,
            )
            for link in c.links
        ],
    )


@router.get("/bank/status", response_model=BankStatusOut)
def bank_status() -> BankStatusOut:
    provider = bank_sync.build_provider()
    return BankStatusOut(
        enabled=not isinstance(provider, bank_sync.NullProvider),
        provider=provider.name,
        country=settings.bank_sync_country,
        redirect_url=settings.bank_sync_redirect_url,
    )


@router.get("/bank/institutions", response_model=list[BankOut])
def institutions(country: str | None = None) -> list[BankOut]:
    try:
        banks = bank_sync.build_provider().banks(country or settings.bank_sync_country)
    except bank_sync.BankSyncError as exc:
        raise _refuse(exc) from exc
    return [BankOut(name=b.name, country=b.country, logo=b.logo) for b in banks]


@router.post("/bank/connections", response_model=ConnectOut, status_code=201)
def connect(payload: ConnectIn, session: Session = Depends(get_session)) -> ConnectOut:
    try:
        connection, url = bank_sync.start_connection(
            session,
            bank_sync.build_provider(),
            bank=payload.bank,
            country=(payload.country or settings.bank_sync_country).upper(),
            redirect_url=settings.bank_sync_redirect_url,
            now=clock.now(),
        )
    except bank_sync.BankSyncError as exc:
        session.rollback()
        raise _refuse(exc) from exc
    return ConnectOut(connection_id=connection.id, url=url)


@router.post("/bank/callback", response_model=ConnectionOut)
def callback(payload: CallbackIn, session: Session = Depends(get_session)) -> ConnectionOut:
    try:
        connection = bank_sync.complete_connection(
            session, bank_sync.build_provider(), code=payload.code, state=payload.state
        )
    except bank_sync.BankSyncError as exc:
        session.rollback()
        raise _refuse(exc) from exc
    return _connection_out(connection)


@router.get("/bank/connections", response_model=list[ConnectionOut])
def connections(session: Session = Depends(get_session)) -> list[ConnectionOut]:
    now = clock.now()
    rows = list(
        session.scalars(
            select(BankConnection)
            .where(BankConnection.status != BankConnectionStatus.PENDING)
            .order_by(BankConnection.created_at.desc(), BankConnection.id)
        )
    )
    for c in rows:
        bank_sync.refresh_status(c, now)
    session.commit()
    return [_connection_out(c) for c in rows]


@router.patch("/bank/links/{link_id}", response_model=ConnectionOut)
def map_link(link_id: uuid.UUID, payload: LinkEditIn, session: Session = Depends(get_session)) -> ConnectionOut:
    link = session.get(BankLink, link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="bank account not found")
    if payload.account_id is not None:
        try:
            importing.importable_account(session, payload.account_id)
        except importing.ImportError_ as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        if link.currency != "GBP":
            raise HTTPException(
                status_code=422,
                detail=f"This bank account is in {link.currency}; the ledger holds pounds only.",
            )
    link.account_id = payload.account_id
    session.commit()
    return _connection_out(link.connection)


@router.post("/bank/links/{link_id}/sync", response_model=SyncOut)
def sync(link_id: uuid.UUID, session: Session = Depends(get_session)) -> SyncOut:
    link = session.get(BankLink, link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="bank account not found")
    try:
        result = bank_sync.sync_link(
            session, bank_sync.build_provider(), link, today=clock_today(session), now=clock.now()
        )
    except (bank_sync.BankSyncError, importing.ImportError_) as exc:
        session.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return SyncOut(**result.__dict__)


@router.post("/bank/connections/{connection_id}/disconnect", response_model=ConnectionOut)
def disconnect(connection_id: uuid.UUID, session: Session = Depends(get_session)) -> ConnectionOut:
    connection = session.get(BankConnection, connection_id)
    if connection is None:
        raise HTTPException(status_code=404, detail="connection not found")
    bank_sync.disconnect(session, bank_sync.build_provider(), connection)
    return _connection_out(connection)
