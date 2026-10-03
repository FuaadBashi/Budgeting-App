"""The single-user settings row, and the one place the protected buffer is read.

Safe-to-spend, the balance curve, budget recovery and the simulator each read
``profile.protected_cash_buffer if profile else ZERO`` on their own; a settings
screen would have made a sixth copy. One selector keeps "no profile yet" meaning
£0 everywhere, so the figure the settings screen shows is the figure every
engine subtracts.
"""

from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.money import ZERO
from app.models.planning import UserProfile


def protected_buffer(session: Session) -> Decimal:
    """Rulebook section 4's ProtectedBuffer. A fresh install has no profile: £0."""
    profile = session.scalars(select(UserProfile)).first()
    return profile.protected_cash_buffer if profile else ZERO


def set_protected_buffer(session: Session, amount: Decimal) -> Decimal:
    """Store the buffer, creating the profile row on a fresh install.

    The row's column defaults (Europe/London, 7- and 30-day near-term windows)
    are the same fallbacks every engine uses when the row is missing, so
    creating it changes nothing but the buffer.
    """
    if amount < ZERO:
        # Below zero would add money to safe-to-spend that does not exist.
        raise ValueError("the protected buffer cannot be negative")
    profile = session.scalars(select(UserProfile)).first()
    if profile is None:
        profile = UserProfile()
        session.add(profile)
    profile.protected_cash_buffer = amount
    session.commit()
    return profile.protected_cash_buffer
