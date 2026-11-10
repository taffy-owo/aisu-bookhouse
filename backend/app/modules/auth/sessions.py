from datetime import datetime, timedelta, timezone
from hashlib import sha256
from uuid import uuid4

from sqlalchemy import update
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.security import create_refresh_token
from app.modules.auth.models import AuthSessionRecord, ApiTokenRecord
from app.modules.users.domain import User


def hash_refresh_token(token: str) -> str:
    return sha256(token.encode("utf-8")).hexdigest()


def create_session(session: Session, user: User, settings: Settings) -> tuple[str, str]:
    now = datetime.now(timezone.utc)
    session_id = str(uuid4())
    refresh_token = create_refresh_token(
        subject=user.id, password_hash=user.password_hash, session_id=session_id, settings=settings
    )
    session.add(AuthSessionRecord(
        id=session_id,
        user_id=user.id,
        refresh_token_hash=hash_refresh_token(refresh_token),
        expires_at=now + timedelta(days=settings.jwt_refresh_expire_days),
        created_at=now,
    ))
    session.commit()
    return session_id, refresh_token


def session_is_active(session: Session, session_id: str, user_id: str) -> bool:
    record = session.get(AuthSessionRecord, session_id)
    if record is None or record.user_id != user_id or record.revoked_at is not None:
        return False
    expires_at = record.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at > datetime.now(timezone.utc)


def rotate_refresh_token(
    session: Session, *, session_id: str, user: User, old_token: str, settings: Settings
) -> str | None:
    if not session_is_active(session, session_id, user.id):
        return None
    now = datetime.now(timezone.utc)
    new_token = create_refresh_token(
        subject=user.id, password_hash=user.password_hash, session_id=session_id, settings=settings
    )
    result = session.execute(
        update(AuthSessionRecord)
        .where(
            AuthSessionRecord.id == session_id,
            AuthSessionRecord.user_id == user.id,
            AuthSessionRecord.refresh_token_hash == hash_refresh_token(old_token),
            AuthSessionRecord.revoked_at.is_(None),
        )
        .values(
            refresh_token_hash=hash_refresh_token(new_token),
            expires_at=now + timedelta(days=settings.jwt_refresh_expire_days),
            rotated_at=now,
        )
    )
    session.commit()
    return new_token if result.rowcount == 1 else None


def revoke_session(session: Session, session_id: str) -> None:
    session.execute(
        update(AuthSessionRecord)
        .where(AuthSessionRecord.id == session_id, AuthSessionRecord.revoked_at.is_(None))
        .values(revoked_at=datetime.now(timezone.utc))
    )
    session.commit()


def revoke_all_user_sessions(session: Session, user_id: str, *, commit: bool = True) -> None:
    session.execute(
        update(AuthSessionRecord)
        .where(AuthSessionRecord.user_id == user_id, AuthSessionRecord.revoked_at.is_(None))
        .values(revoked_at=datetime.now(timezone.utc))
    )
    session.execute(update(ApiTokenRecord).where(ApiTokenRecord.user_id == user_id,
        ApiTokenRecord.revoked_at.is_(None)).values(revoked_at=datetime.now(timezone.utc)))
    if commit:
        session.commit()
