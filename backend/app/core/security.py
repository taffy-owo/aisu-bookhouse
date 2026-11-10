from datetime import datetime, timedelta, timezone
from hashlib import sha256
from uuid import uuid4

import bcrypt
import jwt
from fastapi import HTTPException, status

from app.core.config import Settings


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    # bcrypt 5 raises for oversized passwords instead of returning False.
    # Login and change-password must reject invalid input, not return a 500.
    if len(password.encode("utf-8")) > 72:
        return False
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


def create_access_token(subject: str, settings: Settings, *, session_id: str) -> str:
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes)
    payload = {"sub": subject, "sid": session_id, "token_type": "access", "exp": expires_at}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str, settings: Settings) -> tuple[str, str]:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token") from exc

    subject = payload.get("sub")
    token_type = payload.get("token_type")
    # Access tokens issued before refresh support had no token_type claim.
    if token_type not in {None, "access"} or "ticket_type" in payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token type")
    session_id = payload.get("sid")
    if not isinstance(subject, str) or not subject or not isinstance(session_id, str) or not session_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token subject")

    return subject, session_id


def create_refresh_token(*, subject: str, password_hash: str, session_id: str, settings: Settings) -> str:
    expires_at = datetime.now(timezone.utc) + timedelta(days=settings.jwt_refresh_expire_days)
    payload = {
        "sub": subject,
        "sid": session_id,
        "credential": credential_fingerprint(password_hash),
        "jti": str(uuid4()),
        "token_type": "refresh",
        "exp": expires_at,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_refresh_token(token: str, settings: Settings) -> tuple[str, str, str]:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token") from exc

    subject = payload.get("sub")
    credential = payload.get("credential")
    session_id = payload.get("sid")
    if (payload.get("token_type") != "refresh" or not isinstance(subject, str) or not subject
            or not isinstance(credential, str) or not isinstance(session_id, str) or not session_id):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    return subject, credential, session_id


def credential_fingerprint(password_hash: str) -> str:
    return sha256(password_hash.encode("utf-8")).hexdigest()


def create_file_ticket(*, subject: str, book_id: str, purpose: str, settings: Settings, expires_minutes: int = 240) -> str:
    """Create a short, narrowly scoped URL token for browser-native streaming."""
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=expires_minutes)
    payload = {
        "sub": subject,
        "book_id": book_id,
        "purpose": purpose,
        "ticket_type": "book_file",
        "exp": expires_at,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_file_ticket(token: str, settings: Settings) -> tuple[str, str, str]:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid file ticket") from exc

    subject = payload.get("sub")
    book_id = payload.get("book_id")
    purpose = payload.get("purpose")
    if payload.get("ticket_type") != "book_file" or not all(isinstance(value, str) and value for value in (subject, book_id, purpose)):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid file ticket")
    return subject, book_id, purpose

