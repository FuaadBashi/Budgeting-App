"""Bank connections: consent to read an account, and where its rows land.

A connection is one consent granted at one bank; a link is one of that bank's
accounts, mapped to the ledger account its rows are staged into. Synced rows
become import candidates like a statement's -- nothing reaches the ledger until
a person accepts it (X13) -- so these tables hold how to fetch, never money.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Money, TimestampedUUID
from app.models.enums import BankConnectionStatus


class BankConnection(TimestampedUUID, Base):
    __tablename__ = "bank_connections"
    __table_args__ = (
        CheckConstraint(
            "status <> 'ACTIVE' OR session_id IS NOT NULL",
            name="ck_bank_active_has_session",
        ),
    )

    provider: Mapped[str] = mapped_column(String(40), nullable=False)
    aspsp_name: Mapped[str] = mapped_column(String(120), nullable=False)
    aspsp_country: Mapped[str] = mapped_column(String(2), nullable=False)
    status: Mapped[BankConnectionStatus] = mapped_column(
        Enum(BankConnectionStatus, name="bank_connection_status", native_enum=False),
        nullable=False,
        default=BankConnectionStatus.PENDING,
    )
    #: One-use token tying the bank's redirect back to this request (CSRF).
    #: Cleared once the redirect is honoured, so it cannot be replayed.
    state: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)
    #: The provider's session. Inert without the application's private key,
    #: which lives on disk and is never stored here.
    session_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    valid_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    links: Mapped[list[BankLink]] = relationship(
        back_populates="connection", lazy="selectin", order_by="BankLink.name"
    )


class BankLink(TimestampedUUID, Base):
    __tablename__ = "bank_links"
    __table_args__ = (
        UniqueConstraint("connection_id", "provider_account_id", name="uq_bank_link_account"),
    )

    connection_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("bank_connections.id"), nullable=False, index=True
    )
    provider_account_id: Mapped[str] = mapped_column(String(120), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    #: Masked: the last four digits are enough to recognise an account and
    #: nothing more is worth keeping.
    identifier: Mapped[str | None] = mapped_column(String(40), nullable=True)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="GBP")
    #: Unmapped until a person chooses; an unmapped link is never synced.
    account_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("accounts.id"), nullable=True
    )
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    #: The latest booking date fetched. The next sync starts a week before it,
    #: because banks back-date late-settling rows.
    synced_through: Mapped[date | None] = mapped_column(Date, nullable=True)
    #: What the bank said at the last sync -- an external fact to compare the
    #: ledger against, not a figure the app derives.
    bank_balance: Mapped[Decimal | None] = mapped_column(Money, nullable=True)
    bank_balance_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    connection: Mapped[BankConnection] = relationship(back_populates="links")
