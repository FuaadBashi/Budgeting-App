"""The protected cash buffer: the floor of cash safe-to-spend never dips into.

It lived on UserProfile with no route, so it could only be set in the database,
and the dashboard could only say that none was set.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.api.schemas import from_minor, to_minor
from app.db import get_session
from app.domain.profile import protected_buffer, set_protected_buffer

router = APIRouter()

#: The largest integer a browser holds exactly (2^53 - 1). Anything above it
#: would come back to the screen as a different number than was saved.
MAX_SAFE_MINOR = 9_007_199_254_740_991


class BufferIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    amount_minor: int = Field(ge=0, le=MAX_SAFE_MINOR)


class BufferOut(BaseModel):
    amount_minor: int


@router.get("/protected-buffer", response_model=BufferOut)
def get_buffer(session: Session = Depends(get_session)) -> BufferOut:
    return BufferOut(amount_minor=to_minor(protected_buffer(session)))


@router.put("/protected-buffer", response_model=BufferOut)
def put_buffer(payload: BufferIn, session: Session = Depends(get_session)) -> BufferOut:
    stored = set_protected_buffer(session, from_minor(payload.amount_minor))
    return BufferOut(amount_minor=to_minor(stored))
