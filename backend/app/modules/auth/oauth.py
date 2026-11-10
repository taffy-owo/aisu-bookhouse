"""OAuth provider adapters and short lived, one time login tickets.

Provider access tokens are used only during the callback and are never stored.
The browser receives a one time ticket, then exchanges it over the normal
authenticated API so access tokens never appear in a URL.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from secrets import token_urlsafe
from typing import Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4

import httpx
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.modules.auth.models import OAuthAccountRecord, OAuthLoginTicketRecord
from app.modules.users.domain import User
from app.modules.users.repository import UserRepository

OAuthProvider = Literal["google", "discord"]
OAUTH_STATE_COOKIE_PREFIX = "aisu_oauth_state_"
OAUTH_STATE_TTL_SECONDS = 10 * 60
OAUTH_TICKET_TTL_SECONDS = 5 * 60


class OAuthError(Exception):
    """An expected OAuth failure safe to expose as a short error code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class OAuthProviderConfig:
    name: OAuthProvider
    client_id: str
    client_secret: str
    redirect_uri: str
    authorization_endpoint: str
    token_endpoint: str
    profile_endpoint: str
    scopes: tuple[str, ...]

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.client_secret and self.redirect_uri)


@dataclass(frozen=True)
class OAuthProfile:
    provider: OAuthProvider
    subject: str
    email: str
    email_verified: bool
    nickname: str


def get_provider_config(settings: Settings, provider: str) -> OAuthProviderConfig:
    if provider == "google":
        return OAuthProviderConfig(
            name="google",
            client_id=settings.google_oauth_client_id,
            client_secret=settings.google_oauth_client_secret,
            redirect_uri=settings.google_oauth_redirect_uri,
            authorization_endpoint="https://accounts.google.com/o/oauth2/v2/auth",
            token_endpoint="https://oauth2.googleapis.com/token",
            profile_endpoint="https://openidconnect.googleapis.com/v1/userinfo",
            scopes=("openid", "email", "profile"),
        )
    if provider == "discord":
        return OAuthProviderConfig(
            name="discord",
            client_id=settings.discord_oauth_client_id,
            client_secret=settings.discord_oauth_client_secret,
            redirect_uri=settings.discord_oauth_redirect_uri,
            authorization_endpoint="https://discord.com/oauth2/authorize",
            token_endpoint="https://discord.com/api/oauth2/token",
            profile_endpoint="https://discord.com/api/users/@me",
            scopes=("identify", "email"),
        )
    raise OAuthError("unsupported_provider")


def configured_providers(settings: Settings) -> dict[OAuthProvider, bool]:
    return {
        "google": get_provider_config(settings, "google").configured,
        "discord": get_provider_config(settings, "discord").configured,
    }


def build_authorization_url(config: OAuthProviderConfig, state: str) -> str:
    params = {
        "client_id": config.client_id,
        "redirect_uri": config.redirect_uri,
        "response_type": "code",
        "scope": " ".join(config.scopes),
        "state": state,
    }
    if config.name == "google":
        params.update({"access_type": "online", "include_granted_scopes": "true"})
    else:
        params["prompt"] = "consent"
    return f"{config.authorization_endpoint}?{urlencode(params)}"


async def fetch_profile(config: OAuthProviderConfig, code: str) -> OAuthProfile:
    try:
        async with httpx.AsyncClient(timeout=12.0, follow_redirects=False) as client:
            token_response = await client.post(
                config.token_endpoint,
                data={
                    "client_id": config.client_id,
                    "client_secret": config.client_secret,
                    "code": code,
                    "grant_type": "authorization_code",
                    "redirect_uri": config.redirect_uri,
                },
                headers={"Accept": "application/json"},
            )
            token_response.raise_for_status()
            token_payload = token_response.json()
            access_token = token_payload.get("access_token") if isinstance(token_payload, dict) else None
            if not isinstance(access_token, str) or not access_token:
                raise OAuthError("provider_token_failed")

            profile_response = await client.get(
                config.profile_endpoint,
                headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
            )
            profile_response.raise_for_status()
            payload = profile_response.json()
    except OAuthError:
        raise
    except (httpx.HTTPError, ValueError, TypeError) as error:
        raise OAuthError("provider_unavailable") from error

    if config.name == "google":
        subject = payload.get("sub")
        email = payload.get("email")
        verified = payload.get("email_verified") is True
        nickname = payload.get("name") or payload.get("email") or "Google 用户"
    else:
        subject = payload.get("id")
        email = payload.get("email")
        verified = payload.get("verified") is True
        nickname = payload.get("global_name") or payload.get("username") or "Discord 用户"

    if not isinstance(subject, str) or not subject or not isinstance(email, str) or not email.strip():
        raise OAuthError("provider_email_missing")
    if not verified:
        raise OAuthError("provider_email_unverified")

    return OAuthProfile(
        provider=config.name,
        subject=subject,
        email=email.strip().lower(),
        email_verified=True,
        nickname=str(nickname).strip()[:80] or ("Google 用户" if config.name == "google" else "Discord 用户"),
    )


def state_cookie_name(provider: OAuthProvider) -> str:
    return f"{OAUTH_STATE_COOKIE_PREFIX}{provider}"


def create_oauth_state() -> str:
    return token_urlsafe(32)


def create_login_ticket(session: Session, user_id: str) -> str:
    raw_ticket = token_urlsafe(32)
    now = datetime.now(timezone.utc)
    session.add(
        OAuthLoginTicketRecord(
            token_hash=hash_secret(raw_ticket),
            user_id=user_id,
            expires_at=now + timedelta(seconds=OAUTH_TICKET_TTL_SECONDS),
            created_at=now,
        )
    )
    session.commit()
    return raw_ticket


def consume_login_ticket(session: Session, raw_ticket: str) -> str | None:
    record = session.get(OAuthLoginTicketRecord, hash_secret(raw_ticket))
    if record is None or record.used_at is not None:
        return None
    expires_at = record.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    if expires_at <= now:
        return None
    result = session.execute(
        update(OAuthLoginTicketRecord)
        .where(
            OAuthLoginTicketRecord.token_hash == record.token_hash,
            OAuthLoginTicketRecord.used_at.is_(None),
            OAuthLoginTicketRecord.expires_at > now,
        )
        .values(used_at=now)
        .execution_options(synchronize_session=False)
    )
    session.commit()
    return record.user_id if result.rowcount == 1 else None


def hash_secret(value: str) -> str:
    return sha256(value.encode("utf-8")).hexdigest()


def find_or_link_user(
    session: Session, profile: OAuthProfile, user_repository: UserRepository
) -> User:
    identity = session.scalar(
        select(OAuthAccountRecord).where(
            OAuthAccountRecord.provider == profile.provider,
            OAuthAccountRecord.provider_subject == profile.subject,
        )
    )
    if identity is not None:
        user = user_repository.get_by_id(identity.user_id)
        if user is None or user.status != "active":
            raise OAuthError("account_disabled")
        return user

    user = user_repository.get_by_email(profile.email)
    if user is None or user.status != "active":
        # Registration still requires an invitation, so social login cannot
        # silently create an account with a provider-controlled email address.
        raise OAuthError("account_not_linked")

    now = datetime.now(timezone.utc)
    session.add(
        OAuthAccountRecord(
            id=str(uuid4()),
            user_id=user.id,
            provider=profile.provider,
            provider_subject=profile.subject,
            email=profile.email,
            created_at=now,
            updated_at=now,
        )
    )
    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        identity = session.scalar(
            select(OAuthAccountRecord).where(
                OAuthAccountRecord.provider == profile.provider,
                OAuthAccountRecord.provider_subject == profile.subject,
            )
        )
        if identity is None or identity.user_id != user.id:
            raise OAuthError("account_link_conflict") from error
    return user


def frontend_redirect(settings: Settings, *, error: str | None = None, ticket: str | None = None) -> str:
    parsed = urlsplit(settings.oauth_frontend_redirect_uri)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    if error:
        query["oauth_error"] = error
    if ticket:
        query["oauth_ticket"] = ticket
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))
