"""Categorisation rules: a person's standing instructions for incoming rows.

The merchant cache already remembers a category a person picked for one exact
merchant. A rule is the general form -- "anything containing AMAZON is
Shopping", "TFL under £10 is Transport", "rename SQ *BLUE BOTTLE to Blue
Bottle" -- and because a person wrote it, it outranks the cache and the model
alike (A2 applied to patterns rather than single merchants).

Rules are deactivated, never deleted: CLAUDE.md allows deletion only for
scenarios and old backups, and a rule's name is recorded on every candidate it
touched, so the record of why a row was categorised stays legible.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

from sqlalchemy import Boolean, CheckConstraint, Enum, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Money, TimestampedUUID
from app.models.enums import RuleDirection, RuleField, RuleMatch


class CategorisationRule(TimestampedUUID, Base):
    __tablename__ = "categorisation_rules"
    __table_args__ = (
        # A rule that sets nothing matches rows and changes nothing -- it would
        # silently shadow every rule after it.
        CheckConstraint(
            "set_category_id IS NOT NULL OR set_merchant IS NOT NULL",
            name="ck_rule_sets_something",
        ),
        CheckConstraint("length(btrim(pattern)) > 0", name="ck_rule_pattern_not_blank"),
        CheckConstraint(
            "amount_min IS NULL OR amount_max IS NULL OR amount_min <= amount_max",
            name="ck_rule_amount_range",
        ),
    )

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    #: Lower runs first; the first match wins.
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    field: Mapped[RuleField] = mapped_column(
        Enum(RuleField, name="rule_field", native_enum=False),
        nullable=False,
        default=RuleField.EITHER,
    )
    match: Mapped[RuleMatch] = mapped_column(
        Enum(RuleMatch, name="rule_match", native_enum=False),
        nullable=False,
        default=RuleMatch.CONTAINS,
    )
    pattern: Mapped[str] = mapped_column(String(200), nullable=False)

    #: Magnitude bounds, inclusive. A person thinks of "Netflix is £10.99", not
    #: "-10.99"; direction is a separate condition.
    amount_min: Mapped[Decimal | None] = mapped_column(Money, nullable=True)
    amount_max: Mapped[Decimal | None] = mapped_column(Money, nullable=True)
    direction: Mapped[RuleDirection] = mapped_column(
        Enum(RuleDirection, name="rule_direction", native_enum=False),
        nullable=False,
        default=RuleDirection.ANY,
    )
    account_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("accounts.id"), nullable=True
    )

    set_category_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("categories.id"), nullable=True
    )
    #: Written to the row's merchant: the display name a person wants to read.
    set_merchant: Mapped[str | None] = mapped_column(String(200), nullable=True)
