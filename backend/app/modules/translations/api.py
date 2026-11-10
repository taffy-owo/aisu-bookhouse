from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.dependencies import get_app_settings, get_current_user, get_db_session
from app.modules.translations.schemas import CreateWholeBookTranslationRequest, SourceUpdateTranslationDraftReview, UpdateTranslationConcurrencyRequest, UpdateTranslationModelRequest, WholeBookTranslationJobPublic, WholeBookTranslationNotificationList
from app.modules.translations.service import accept_source_update_translation, acknowledge_translation_job, clear_finished_translation_jobs, create_whole_book_translation_job, delete_translation_job, get_source_update_translation_review, get_translation_notifications, get_translation_job, list_translation_jobs, pause_translation_job, reject_source_update_translation, resume_translation_job, retry_translation_job, update_translation_job_concurrency, update_translation_job_model
from app.modules.users.domain import User
from app.modules.translations.maintenance import require_translation_active
from app.modules.translations.external_completion import (
    ExternalSourceManifest, SourceCheckpoint, ReconcileRequest, ReconcileResult,
    external_manifest, export_source, reconcile_external,
)

router = APIRouter(tags=["whole-book-translations"])


@router.get('/{job_id}/external', response_model=ExternalSourceManifest)
def get_external_source_manifest(job_id: str, response: Response,
    current_user: User = Depends(get_current_user), session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings)):
    """Export task catalog and checkpoint availability without credentials or internal paths."""
    response.headers['Cache-Control'] = 'no-store'
    return external_manifest(session, current_user.id, job_id, settings)


@router.get('/{job_id}/external/chapters/{index}', response_model=SourceCheckpoint)
def get_external_source_chapter(job_id: str, index: int, response: Response,
    current_user: User = Depends(get_current_user), session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings)):
    """Read a verified cached source chapter; missing/damaged checkpoints return 409."""
    response.headers['Cache-Control'] = 'no-store'
    return export_source(session, current_user.id, job_id, index, settings)


@router.post('/{job_id}/reconcile', response_model=ReconcileResult)
def reconcile_external_publication(job_id: str, payload: ReconcileRequest, response: Response, request: Request,
    current_user: User = Depends(get_current_user), session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings)):
    """Complete a stopped task only after matching original, reader and source coverage."""
    scope = getattr(request.state, 'api_book_scope', None)
    if scope and scope != str(payload.book_id):
        raise HTTPException(403, 'API credential is restricted to one book')
    response.headers['Cache-Control'] = 'no-store'
    return reconcile_external(session, current_user.id, job_id, payload, settings)


@router.post("", response_model=WholeBookTranslationJobPublic, status_code=status.HTTP_202_ACCEPTED)
async def create_translation_job(
    payload: CreateWholeBookTranslationRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> WholeBookTranslationJobPublic:
    return await create_whole_book_translation_job(
        user_id=current_user.id,
        source_url=payload.source_url,
        model=payload.model.strip(),
        channel_id=payload.channel_id,
        custom_instructions=(
            payload.custom_instructions
            if payload.custom_instructions is not None
            else current_user.ai_translation_prompt
        ),
        request_concurrency=payload.request_concurrency or current_user.ai_translation_concurrency,
        session=session,
        settings=settings,
    )


@router.get("", response_model=list[WholeBookTranslationJobPublic])
def get_translation_jobs(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
) -> list[WholeBookTranslationJobPublic]:
    return list_translation_jobs(current_user.id, session, offset=offset, limit=limit)


@router.delete("/completed")
def clear_completed_translation_jobs(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> dict[str, int]:
    return {"deleted": clear_finished_translation_jobs(current_user.id, session, settings)}


@router.delete("/{job_id}")
def delete_job(
    job_id: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> dict[str, int]:
    deleted = delete_translation_job(current_user.id, job_id, session, settings)
    if deleted is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Translation job not found")
    return {"deleted": 1}


@router.get("/notifications", response_model=WholeBookTranslationNotificationList)
def get_notifications(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
) -> WholeBookTranslationNotificationList:
    return get_translation_notifications(current_user.id, session)


@router.get("/{job_id}/review", response_model=SourceUpdateTranslationDraftReview)
def get_update_translation_review(
    job_id: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> SourceUpdateTranslationDraftReview:
    review = get_source_update_translation_review(current_user.id, job_id, session, settings)
    if not review:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Translation draft not found")
    return review


@router.get("/{job_id}", response_model=WholeBookTranslationJobPublic)
def get_job(
    job_id: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
) -> WholeBookTranslationJobPublic:
    job = get_translation_job(current_user.id, job_id, session)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Translation job not found")
    return job


@router.post("/{job_id}/accept", response_model=WholeBookTranslationJobPublic)
def accept_update_translation(
    job_id: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> WholeBookTranslationJobPublic:
    job = accept_source_update_translation(current_user.id, job_id, session, settings)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Translation draft not found")
    return job


@router.post("/{job_id}/reject", response_model=WholeBookTranslationJobPublic)
def reject_update_translation(
    job_id: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> WholeBookTranslationJobPublic:
    job = reject_source_update_translation(current_user.id, job_id, session, settings)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Translation draft not found")
    return job


@router.post("/{job_id}/acknowledge", response_model=WholeBookTranslationJobPublic)
def acknowledge_job(
    job_id: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
) -> WholeBookTranslationJobPublic:
    job = acknowledge_translation_job(current_user.id, job_id, session)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Translation job not found")
    return job


@router.post("/{job_id}/retry", response_model=WholeBookTranslationJobPublic)
def retry_job(
    job_id: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> WholeBookTranslationJobPublic:
    require_translation_active(settings, current_user.id)
    job = retry_translation_job(current_user.id, job_id, session)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Translation job not found")
    return job


@router.post("/{job_id}/pause", response_model=WholeBookTranslationJobPublic)
def pause_job(
    job_id: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
) -> WholeBookTranslationJobPublic:
    job = pause_translation_job(current_user.id, job_id, session)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Translation job not found")
    return job


@router.post("/{job_id}/resume", response_model=WholeBookTranslationJobPublic)
def resume_job(
    job_id: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> WholeBookTranslationJobPublic:
    require_translation_active(settings, current_user.id)
    job = resume_translation_job(current_user.id, job_id, session)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Translation job not found")
    return job


@router.patch("/{job_id}/concurrency", response_model=WholeBookTranslationJobPublic)
def update_job_concurrency(
    job_id: str,
    payload: UpdateTranslationConcurrencyRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
) -> WholeBookTranslationJobPublic:
    job = update_translation_job_concurrency(current_user.id, job_id, payload.request_concurrency, session)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Translation job not found")
    return job


@router.patch("/{job_id}/model", response_model=WholeBookTranslationJobPublic)
def update_job_model(
    job_id: str,
    payload: UpdateTranslationModelRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> WholeBookTranslationJobPublic:
    job = update_translation_job_model(
        current_user.id, job_id, payload.model.strip(), payload.channel_id, session, settings
    )
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Translation job not found")
    return job
