from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.dependencies import get_app_settings, get_current_user, get_db_session
from app.modules.ai_channels.schemas import (
    AiChannelProbeResult,
    AiChannelPublic,
    CreateAiChannelRequest,
    TranslationModelOption,
    UpdateAiChannelRequest,
)
from app.modules.ai_channels.service import (
    create_channel,
    delete_channel,
    get_channel,
    list_channels,
    list_translation_model_options,
    probe_channel_models,
    update_channel,
)
from app.modules.users.domain import User


router = APIRouter(tags=["ai-channels"])


@router.get("", response_model=list[AiChannelPublic])
def get_channels(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> list[AiChannelPublic]:
    return list_channels(current_user.id, session, settings)


@router.get("/translation-models", response_model=list[TranslationModelOption])
def get_translation_model_options(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
) -> list[TranslationModelOption]:
    return list_translation_model_options(current_user.id, session)


@router.post("", response_model=AiChannelPublic, status_code=status.HTTP_201_CREATED)
def post_channel(
    payload: CreateAiChannelRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> AiChannelPublic:
    return create_channel(
        user_id=current_user.id,
        name=payload.name,
        base_url=payload.base_url,
        api_key=payload.api_key,
        enabled=payload.enabled,
        models=payload.models,
        session=session,
        settings=settings,
    )


@router.get("/{channel_id}", response_model=AiChannelPublic)
def get_one_channel(
    channel_id: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> AiChannelPublic:
    channel = get_channel(current_user.id, channel_id, session, settings)
    if not channel:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="渠道不存在")
    return channel


@router.patch("/{channel_id}", response_model=AiChannelPublic)
def patch_channel(
    channel_id: str,
    payload: UpdateAiChannelRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> AiChannelPublic:
    channel = update_channel(
        user_id=current_user.id,
        channel_id=channel_id,
        name=payload.name,
        base_url=payload.base_url,
        api_key=payload.api_key,
        enabled=payload.enabled,
        sort_order=payload.sort_order,
        models=payload.models,
        expected_updated_at=payload.expected_updated_at,
        session=session,
        settings=settings,
    )
    if not channel:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="渠道不存在")
    return channel


@router.delete("/{channel_id}")
def remove_channel(
    channel_id: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
) -> dict[str, int]:
    deleted = delete_channel(current_user.id, channel_id, session)
    if deleted is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="渠道不存在")
    return {"deleted": 1}


@router.post("/{channel_id}/probe", response_model=AiChannelProbeResult)
async def probe_channel(
    channel_id: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> AiChannelProbeResult:
    try:
        models = await probe_channel_models(
            user_id=current_user.id, channel_id=channel_id, session=session, settings=settings
        )
    except HTTPException:
        raise
    except Exception as error:  # noqa: BLE001 - surfaced verbatim so the user can fix the channel
        return AiChannelProbeResult(
            channel_id=channel_id, ok=False, detail=str(error)[:300], models=[]
        )
    return AiChannelProbeResult(
        channel_id=channel_id,
        ok=True,
        detail=f"连接正常，返回 {len(models)} 个模型",
        models=models,
    )
