from dataclasses import replace
from datetime import datetime, timezone
import hmac
import logging
from pathlib import Path

import httpx
from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Request, Response, UploadFile, File, status
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy.orm import Session
from sqlalchemy import select

from app.core.config import Settings
from app.core.dependencies import get_current_user, get_db_session, get_invitation_repository, get_user_repository, get_app_settings
from app.core.security import create_access_token, credential_fingerprint, decode_access_token, decode_refresh_token
from app.modules.auth.schemas import (
    ChangePasswordRequest,
    LoginRequest,
    OAuthProvidersResponse,
    OAuthTicketRequest,
    RegisterRequest,
    TokenResponse,
    UpdateProfileRequest,
)
from app.modules.auth.oauth import (
    OAuthError,
    OAUTH_STATE_TTL_SECONDS,
    build_authorization_url,
    configured_providers,
    consume_login_ticket,
    create_login_ticket,
    create_oauth_state,
    fetch_profile,
    find_or_link_user,
    frontend_redirect,
    get_provider_config,
    state_cookie_name,
)
from app.modules.auth.service import authenticate_user, change_user_password, register_user_with_invitation
from app.modules.auth.sessions import create_session, revoke_all_user_sessions, revoke_session, rotate_refresh_token, session_is_active
from app.modules.ai_channels.service import add_channel_model_if_missing, delete_channel, ensure_default_channel
from app.modules.ai_channels.models import AiChannelRecord
from app.modules.invitations.repository import InvitationRepository
from app.modules.users.avatar import remove_previous_avatar, save_optimized_avatar
from app.modules.users.ai_settings import (
    apply_user_ai_models,
    decrypt_ai_api_key,
    encrypt_ai_api_key,
    fetch_provider_ai_models,
    normalize_ai_provider_base_url,
)
from app.modules.users.domain import User
from app.modules.users.repository import UserRepository
from app.modules.users.schemas import AiModelListPublic, AiModelListRequest, AiModelSettingsPublic, AiModelSettingsUpdate, UserPublic

router = APIRouter(tags=["auth"])
logger = logging.getLogger(__name__)
AVATAR_MAX_SIZE_BYTES = 5 * 1024 * 1024
SUPPORTED_AVATAR_MEDIA_TYPES_BY_EXTENSION = {
    ".gif": {"image/gif"},
    ".jpeg": {"image/jpeg", "image/jpg"},
    ".jpg": {"image/jpeg", "image/jpg"},
    ".png": {"image/png"},
    ".webp": {"image/webp"},
}
LENIENT_AVATAR_MEDIA_TYPES = {"", "application/octet-stream"}
REFRESH_COOKIE_NAME = "aisu_refresh_token"


@router.get("/oauth/providers", response_model=OAuthProvidersResponse)
def oauth_providers(settings: Settings = Depends(get_app_settings)) -> OAuthProvidersResponse:
    configured = configured_providers(settings)
    return OAuthProvidersResponse(google=configured["google"], discord=configured["discord"])


@router.get("/oauth/{provider}/start")
def oauth_start(provider: str, settings: Settings = Depends(get_app_settings)) -> RedirectResponse:
    try:
        config = get_provider_config(settings, provider)
    except OAuthError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error.code) from error
    if not config.configured:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="oauth_provider_not_configured")

    state = create_oauth_state()
    response = RedirectResponse(url=build_authorization_url(config, state), status_code=status.HTTP_302_FOUND)
    response.set_cookie(
        key=state_cookie_name(config.name),
        value=state,
        httponly=True,
        secure=settings.environment == "production",
        samesite="lax",
        max_age=OAUTH_STATE_TTL_SECONDS,
        path=f"{settings.api_prefix}/auth/oauth/{config.name}",
    )
    return response


@router.get("/oauth/google/callback")
async def google_oauth_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    settings: Settings = Depends(get_app_settings),
    user_repository: UserRepository = Depends(get_user_repository),
    session: Session = Depends(get_db_session),
) -> RedirectResponse:
    return await handle_oauth_callback(
        provider="google", request=request, code=code, state=state, provider_error=error,
        settings=settings, user_repository=user_repository, session=session,
    )


@router.get("/oauth/discord/callback")
async def discord_oauth_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    settings: Settings = Depends(get_app_settings),
    user_repository: UserRepository = Depends(get_user_repository),
    session: Session = Depends(get_db_session),
) -> RedirectResponse:
    return await handle_oauth_callback(
        provider="discord", request=request, code=code, state=state, provider_error=error,
        settings=settings, user_repository=user_repository, session=session,
    )


async def handle_oauth_callback(
    *, provider: str, request: Request, code: str | None, state: str | None,
    provider_error: str | None, settings: Settings, user_repository: UserRepository, session: Session,
) -> RedirectResponse:
    config = get_provider_config(settings, provider)
    state_cookie = state_cookie_name(config.name)
    expected_state = request.cookies.get(state_cookie)

    def failure(code_value: str) -> RedirectResponse:
        response = RedirectResponse(url=frontend_redirect(settings, error=code_value), status_code=status.HTTP_302_FOUND)
        response.delete_cookie(
            key=state_cookie, secure=settings.environment == "production", samesite="lax",
            path=f"{settings.api_prefix}/auth/oauth/{config.name}",
        )
        return response

    if not config.configured:
        return failure("provider_not_configured")
    if provider_error:
        return failure("provider_cancelled")
    if not code or not state or not expected_state or not hmac.compare_digest(state, expected_state):
        return failure("invalid_oauth_state")

    try:
        profile = await fetch_profile(config, code)
        user = find_or_link_user(session, profile, user_repository)
        ticket = create_login_ticket(session, user.id)
    except OAuthError as oauth_error:
        return failure(oauth_error.code)

    response = RedirectResponse(url=frontend_redirect(settings, ticket=ticket), status_code=status.HTTP_302_FOUND)
    response.delete_cookie(
        key=state_cookie, secure=settings.environment == "production", samesite="lax",
        path=f"{settings.api_prefix}/auth/oauth/{config.name}",
    )
    return response


@router.post("/oauth/consume", response_model=TokenResponse)
def consume_oauth_ticket(
    payload: OAuthTicketRequest,
    request: Request,
    response: Response,
    session: Session = Depends(get_db_session),
    user_repository: UserRepository = Depends(get_user_repository),
) -> TokenResponse:
    user_id = consume_login_ticket(session, payload.ticket)
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="oauth_ticket_invalid")
    user = user_repository.get_by_id(user_id)
    if not user or user.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="oauth_account_disabled")
    return create_token_response(user, request, response, session)


@router.post("/login", response_model=TokenResponse)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    user_repository: UserRepository = Depends(get_user_repository),
    session: Session = Depends(get_db_session),
) -> TokenResponse:
    user = authenticate_user(payload.email, payload.password, user_repository)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="邮箱或密码不正确")

    return create_token_response(user, request, response, session)


@router.post("/register", response_model=TokenResponse)
def register(
    payload: RegisterRequest,
    request: Request,
    response: Response,
    invitation_repository: InvitationRepository = Depends(get_invitation_repository),
    user_repository: UserRepository = Depends(get_user_repository),
    session: Session = Depends(get_db_session),
) -> TokenResponse:
    try:
        user = register_user_with_invitation(
            email=payload.email,
            invitation_code=payload.invitation_code,
            invitation_repository=invitation_repository,
            nickname=payload.nickname,
            password=payload.password,
            user_repository=user_repository,
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    return create_token_response(user, request, response, session)


@router.post("/refresh", response_model=TokenResponse)
def refresh_session(
    request: Request,
    response: Response,
    refresh_token: str | None = Cookie(default=None, alias=REFRESH_COOKIE_NAME),
    user_repository: UserRepository = Depends(get_user_repository),
    session: Session = Depends(get_db_session),
) -> TokenResponse | Response:
    if not refresh_token:
        return invalid_refresh_response(request, "Missing refresh token")

    try:
        user_id, credential, session_id = decode_refresh_token(refresh_token, request.app.state.settings)
        user = user_repository.get_by_id(user_id)
        if not user or user.status != "active" or credential != credential_fingerprint(user.password_hash):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
        new_refresh_token = rotate_refresh_token(
            session, session_id=session_id, user=user, old_token=refresh_token, settings=request.app.state.settings
        )
        if new_refresh_token is None:
            if session_is_active(session, session_id, user.id):
                # Another tab may have won the one-time rotation. Deleting its
                # newly set cookie from this later response would log out both.
                return JSONResponse(status_code=status.HTTP_409_CONFLICT, content={"detail": "refresh_already_rotated"})
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    except HTTPException:
        return invalid_refresh_response(request, "Invalid refresh token")

    set_refresh_cookie(response, new_refresh_token, request.app.state.settings)
    return TokenResponse(
        access_token=create_access_token(user.id, request.app.state.settings, session_id=session_id),
        user=UserPublic.model_validate(user),
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: Request,
    response: Response,
    refresh_token: str | None = Cookie(default=None, alias=REFRESH_COOKIE_NAME),
    authorization: str | None = Header(default=None, alias="Authorization"),
    session: Session = Depends(get_db_session),
) -> None:
    session_id = None
    if refresh_token:
        try:
            _, _, session_id = decode_refresh_token(refresh_token, request.app.state.settings)
        except HTTPException:
            pass
    if session_id is None and authorization and authorization.lower().startswith("bearer "):
        try:
            _, session_id = decode_access_token(authorization.split(" ", 1)[1].strip(), request.app.state.settings)
        except HTTPException:
            pass
    if session_id:
        revoke_session(session, session_id)
    clear_refresh_cookie(response, request.app.state.settings)


@router.get("/me", response_model=UserPublic)
def me(current_user: User = Depends(get_current_user)) -> UserPublic:
    return UserPublic.model_validate(current_user)


@router.put("/me", response_model=UserPublic)
def update_profile(
    payload: UpdateProfileRequest,
    current_user: User = Depends(get_current_user),
    user_repository: UserRepository = Depends(get_user_repository),
) -> UserPublic:
    nickname = payload.nickname.strip()
    if not nickname:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Nickname cannot be empty")

    updated_user = _update_current_user(user_repository, current_user, nickname=nickname)
    return UserPublic.model_validate(updated_user)


@router.get("/me/ai-settings", response_model=AiModelSettingsPublic)
def get_ai_model_settings(
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
) -> AiModelSettingsPublic:
    return build_ai_model_settings_response(current_user, settings)


@router.put("/me/ai-settings", response_model=AiModelSettingsPublic)
def update_ai_model_settings(
    payload: AiModelSettingsUpdate,
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    session: Session = Depends(get_db_session),
    user_repository: UserRepository = Depends(get_user_repository),
) -> AiModelSettingsPublic:
    try:
        provider_base_url = current_user.ai_provider_base_url
        if "provider_base_url" in payload.model_fields_set:
            provider_base_url = normalize_ai_provider_base_url(payload.provider_base_url) if payload.provider_base_url else None
        audiobook_provider_base_url = current_user.audiobook_provider_base_url
        if "audiobook_provider_base_url" in payload.model_fields_set:
            audiobook_provider_base_url = (
                normalize_ai_provider_base_url(payload.audiobook_provider_base_url)
                if payload.audiobook_provider_base_url
                else None
            )
        encrypted_api_key = current_user.ai_provider_api_key_encrypted
        if payload.clear_api_key:
            encrypted_api_key = None
        elif payload.api_key:
            encrypted_api_key = encrypt_ai_api_key(payload.api_key, settings)
        encrypted_audiobook_api_key = current_user.audiobook_provider_api_key_encrypted
        if payload.clear_audiobook_api_key:
            encrypted_audiobook_api_key = None
        elif payload.audiobook_api_key:
            encrypted_audiobook_api_key = encrypt_ai_api_key(payload.audiobook_api_key, settings)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    changes: dict[str, object] = {}
    if "provider_base_url" in payload.model_fields_set:
        changes["ai_provider_base_url"] = provider_base_url
    if "audiobook_provider_base_url" in payload.model_fields_set:
        changes["audiobook_provider_base_url"] = audiobook_provider_base_url
    if payload.clear_api_key or payload.api_key:
        changes["ai_provider_api_key_encrypted"] = encrypted_api_key
    if payload.clear_audiobook_api_key or payload.audiobook_api_key:
        changes["audiobook_provider_api_key_encrypted"] = encrypted_audiobook_api_key
    for field, column in (
        ("translation_model", "ai_translation_model"),
        ("translation_prompt", "ai_translation_prompt"),
        ("translation_concurrency", "ai_translation_concurrency"),
        ("audiobook_tts_model", "audiobook_tts_model"),
        ("audiobook_tts_voice", "audiobook_tts_voice"),
    ):
        if field in payload.model_fields_set and (field != "translation_concurrency" or payload.translation_concurrency is not None):
            changes[column] = getattr(payload, field)
    try:
        saved_user = user_repository.update_fields(current_user.id, {"updated_at": datetime.now(timezone.utc), **changes}, commit=False)
        if saved_user is None:
            raise HTTPException(404, "User not found")
        if any(field in changes and changes[field] != getattr(current_user, field) for field in (
            "ai_provider_base_url", "ai_provider_api_key_encrypted", "ai_translation_model",
        )):
            _sync_default_ai_channel(saved_user, session, settings)
        user_repository.commit()
        saved_user = user_repository.get_by_id(current_user.id)
        if saved_user is None:
            raise HTTPException(404, "User not found")
    except Exception:
        user_repository.rollback()
        raise
    return build_ai_model_settings_response(saved_user, settings)


def _sync_default_ai_channel(user: User, session: Session, settings: Settings) -> None:
    """Mirror the legacy single-provider form into the channel tables.

    The settings page can still configure one provider directly; translation jobs
    resolve their lane from the channel tables, so a config saved here has to show
    up there or the user would save a provider and still be unable to start a job.
    """
    if not user.ai_provider_base_url or not user.ai_provider_api_key_encrypted:
        existing = session.scalar(select(AiChannelRecord).where(
            AiChannelRecord.user_id == user.id, AiChannelRecord.is_provider_default.is_(True)))
        if existing:
            delete_channel(user.id, existing.id, session, commit=False)
        return
    channel = ensure_default_channel(
        user_id=user.id,
        base_url=user.ai_provider_base_url,
        api_key_encrypted=user.ai_provider_api_key_encrypted,
        model=user.ai_translation_model or "",
        session=session,
        provider_default=True,
        commit=False,
    )
    if not channel:
        return
    # An existing channel keeps its own name and model list; only re-point the
    # credential and make sure the selected model is present on it.
    channel.base_url = user.ai_provider_base_url
    channel.api_key_encrypted = user.ai_provider_api_key_encrypted
    channel.updated_at = datetime.now(timezone.utc)
    if user.ai_translation_model:
        add_channel_model_if_missing(
            channel_id=channel.id, model=user.ai_translation_model, session=session, commit=False,
        )


@router.get("/me/ai-models", response_model=AiModelListPublic)
async def get_ai_models(
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
) -> AiModelListPublic:
    if not current_user.ai_provider_base_url or not current_user.ai_provider_api_key_encrypted:
        return AiModelListPublic(available=False, models=[])
    try:
        provider_models = await fetch_provider_ai_models(apply_user_ai_models(settings, current_user))
    except (httpx.HTTPError, ValueError):
        return AiModelListPublic(available=False, models=[])
    return AiModelListPublic(available=bool(provider_models), models=provider_models)


@router.post("/me/ai-models", response_model=AiModelListPublic)
async def test_ai_provider_and_get_models(
    payload: AiModelListRequest,
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
) -> AiModelListPublic:
    try:
        base_url = normalize_ai_provider_base_url(payload.provider_base_url)
        api_key = payload.api_key
        saved_encrypted_key = (
            current_user.audiobook_provider_api_key_encrypted
            if payload.credential_scope == "audiobook"
            else current_user.ai_provider_api_key_encrypted
        )
        saved_base_url = (
            current_user.audiobook_provider_base_url
            if payload.credential_scope == "audiobook"
            else current_user.ai_provider_base_url
        )
        if not api_key and saved_encrypted_key:
            if base_url != saved_base_url:
                raise ValueError("修改 Base URL 时请重新填写 API Key")
            api_key = decrypt_ai_api_key(saved_encrypted_key, settings)
        if not api_key:
            raise ValueError("请先填写 API Key")
        provider_settings = replace(
            settings,
            ai_translation_api_key=api_key,
            ai_translation_base_url=base_url,
        )
        models = await fetch_provider_ai_models(provider_settings)
    except (httpx.HTTPError, ValueError) as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="连接失败，请检查 Base URL、API Key 和服务商状态") from error
    return AiModelListPublic(available=bool(models), models=models)


@router.delete("/me/ai-settings", response_model=AiModelSettingsPublic)
def delete_ai_model_settings(
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    user_repository: UserRepository = Depends(get_user_repository),
    session: Session = Depends(get_db_session),
) -> AiModelSettingsPublic:
    channel = session.scalar(select(AiChannelRecord).where(
        AiChannelRecord.user_id == current_user.id, AiChannelRecord.is_provider_default.is_(True)))
    if channel:
        delete_channel(current_user.id, channel.id, session, commit=False)
    saved_user = user_repository.update_fields(current_user.id, dict(
        ai_provider_base_url=None,
        ai_provider_api_key_encrypted=None,
        ai_translation_model=None,
        ai_translation_prompt=None,
        ai_translation_concurrency=2,
        audiobook_provider_base_url=None,
        audiobook_provider_api_key_encrypted=None,
        audiobook_tts_model=None,
        audiobook_tts_voice=None,
        updated_at=datetime.now(timezone.utc),
    ), commit=False)
    user_repository.commit()
    if saved_user is None:
        raise HTTPException(404, "User not found")
    return build_ai_model_settings_response(saved_user, settings)


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: ChangePasswordRequest,
    request: Request,
    response: Response,
    current_user: User = Depends(get_current_user),
    user_repository: UserRepository = Depends(get_user_repository),
    session: Session = Depends(get_db_session),
) -> None:
    try:
        change_user_password(
            user=current_user,
            current_password=payload.current_password,
            new_password=payload.new_password,
            user_repository=user_repository,
            commit=False,
        )
        revoke_all_user_sessions(session, current_user.id, commit=False)
        session.commit()
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    clear_refresh_cookie(response, request.app.state.settings)


def create_token_response(user: User, request: Request, response: Response, session: Session) -> TokenResponse:
    settings = request.app.state.settings
    session_id, refresh_token = create_session(session, user, settings)
    set_refresh_cookie(response, refresh_token, settings)
    return TokenResponse(
        access_token=create_access_token(user.id, settings, session_id=session_id),
        user=UserPublic.model_validate(user),
    )


def build_ai_model_settings_response(user: User, settings: Settings) -> AiModelSettingsPublic:
    provider_configured = bool(user.ai_provider_base_url and user.ai_provider_api_key_encrypted)
    audiobook_provider_configured = bool(
        user.audiobook_provider_base_url and user.audiobook_provider_api_key_encrypted
    )
    return AiModelSettingsPublic(
        api_key_configured=provider_configured,
        audiobook_api_key_configured=audiobook_provider_configured,
        audiobook_provider_base_url=(user.audiobook_provider_base_url or "") if audiobook_provider_configured else "",
        audiobook_tts_model=(user.audiobook_tts_model or "") if audiobook_provider_configured else "",
        audiobook_tts_voice=(user.audiobook_tts_voice or "") if audiobook_provider_configured else "",
        provider_base_url=(user.ai_provider_base_url or "") if provider_configured else "",
        translation_model=(user.ai_translation_model or "") if provider_configured else "",
        translation_secondary_model=settings.ai_translation_secondary_model if provider_configured else "",
        translation_prompt=user.ai_translation_prompt or "",
        translation_concurrency=user.ai_translation_concurrency,
    )


def set_refresh_cookie(response: Response, refresh_token: str, settings: Settings) -> None:
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=refresh_token,
        httponly=True,
        secure=settings.environment == "production",
        samesite="lax",
        max_age=settings.jwt_refresh_expire_days * 24 * 60 * 60,
        path=f"{settings.api_prefix}/auth",
    )


def clear_refresh_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        key=REFRESH_COOKIE_NAME,
        httponly=True,
        secure=settings.environment == "production",
        samesite="lax",
        path=f"{settings.api_prefix}/auth",
    )


def invalid_refresh_response(request: Request, detail: str) -> Response:
    response = JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED, content={"detail": detail})
    clear_refresh_cookie(response, request.app.state.settings)
    return response


@router.post("/me/avatar", response_model=UserPublic)
async def upload_avatar(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    user_repository: UserRepository = Depends(get_user_repository),
) -> UserPublic:
    extension = Path(file.filename or "").suffix.lower()
    allowed_media_types = SUPPORTED_AVATAR_MEDIA_TYPES_BY_EXTENSION.get(extension)
    if not allowed_media_types:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported file format. Please upload PNG, JPG, JPEG, GIF, or WEBP.")

    if (file.content_type or "") not in allowed_media_types | LENIENT_AVATAR_MEDIA_TYPES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported image type. Please upload PNG, JPG, GIF, or WEBP.")

    if not await is_supported_avatar_image(file, extension):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid image file. Please upload a valid PNG, JPG, GIF, or WEBP image.")

    now = datetime.now(timezone.utc)
    avatar_data = await read_avatar_upload(file)
    try:
        relative_path = save_optimized_avatar(data=avatar_data, owner_id=current_user.id, settings=settings, timestamp_ms=int(now.timestamp() * 1000))
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid image file. Please upload a valid PNG, JPG, GIF, or WEBP image.") from error

    try:
        updated_user = user_repository.update_fields(
            current_user.id,
            {"avatar": relative_path, "updated_at": now},
            expected={"avatar": current_user.avatar},
            commit=False,
        )
        if updated_user is None:
            latest_user = user_repository.get_by_id(current_user.id)
            if latest_user is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="头像刚刚更新，请刷新后重试")
        response = UserPublic.model_validate(updated_user)
        user_repository.commit()
    except Exception:
        try:
            user_repository.rollback()
            persisted_user = user_repository.get_by_id(current_user.id)
        except Exception:
            # A commit acknowledgement can fail after the database accepts it.
            # Keep both files unless the persisted pointer is known.
            logger.warning("Could not confirm avatar rollback; retaining uploaded file", exc_info=True)
            raise
        else:
            if persisted_user is not None and persisted_user.avatar == relative_path:
                # The database may have committed before the acknowledgement failed.
                response = UserPublic.model_validate(persisted_user)
            else:
                remove_previous_avatar(relative_path, current_user.avatar or "", settings)
                raise

    remove_previous_avatar(current_user.avatar, relative_path, settings)
    return response


def _update_current_user(user_repository: UserRepository, user: User, **changes: object) -> User:
    updated_user = user_repository.update_fields(user.id, {"updated_at": datetime.now(timezone.utc), **changes})
    if updated_user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return updated_user


async def read_avatar_upload(file: UploadFile) -> bytes:
    await file.seek(0)
    data = await file.read(AVATAR_MAX_SIZE_BYTES + 1)
    if len(data) > AVATAR_MAX_SIZE_BYTES:
        raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail="Avatar image cannot exceed 5MB")
    return data


async def is_supported_avatar_image(file: UploadFile, extension: str) -> bool:
    header = await file.read(16)
    await file.seek(0)

    if extension == ".png":
        return header.startswith(b"\x89PNG\r\n\x1a\n")

    if extension in {".jpg", ".jpeg"}:
        return header.startswith(b"\xff\xd8\xff")

    if extension == ".gif":
        return header.startswith((b"GIF87a", b"GIF89a"))

    if extension == ".webp":
        return len(header) >= 12 and header.startswith(b"RIFF") and header[8:12] == b"WEBP"

    return False
