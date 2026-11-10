from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, Header, HTTPException, Request, UploadFile, status
from uuid import UUID

from app.core.config import Settings
from app.core.dependencies import get_app_settings, get_book_repository, get_current_user, get_upload_task_repository, get_db_session
from sqlalchemy.orm import Session
import logging
from app.modules.books.repository import BookRepository
from app.modules.uploads.repository import UploadTaskRepository
from app.modules.uploads.schemas import UploadBookResponse, UploadTaskPublic, WorkSourceLookupRequest, WorkSourceMetadata
from app.modules.uploads.service import clear_finished_tasks, create_replace_task_for_book, create_reprocess_task_for_book, create_upload_task_from_file, get_task, list_tasks, process_upload_task
from app.modules.uploads.source_metadata import fetch_work_source_metadata
from app.modules.uploads.source_metadata_translation import translate_source_metadata
from app.modules.users.domain import User
from app.modules.uploads.source_metadata_settings import metadata_translation_settings, MetadataProviderConfigurationError

router = APIRouter(tags=["uploads"])


@router.post("/books", response_model=UploadBookResponse)
async def upload_book(
    background_tasks: BackgroundTasks,
    request: Request,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    author: str | None = Form(default=None),
    description: str | None = Form(default=None),
    publication_status: str | None = Form(default=None),
    source_url: str | None = Form(default=None),
    tags: str | None = Form(default=None),
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
    upload_task_repository: UploadTaskRepository = Depends(get_upload_task_repository),
    session: Session = Depends(get_db_session),
    idempotency_key: UUID | None = Header(default=None),
) -> UploadBookResponse:
    arguments = dict(
        owner_id=current_user.id,
        file=file,
        title=title,
        author=author,
        description=description,
        publication_status=publication_status,
        source_url=source_url,
        tags=tags,
        settings=settings,
        external_import=request.headers.get("authorization", "").split(" ", 1)[-1].strip().startswith("aisu_api_"),
    )
    replayed = False
    if idempotency_key:
        from app.modules.uploads.idempotency import create_idempotent_upload
        response, replayed = await create_idempotent_upload(session=session, request_id=idempotency_key, **arguments)
    else:
        response = await create_upload_task_from_file(**arguments, book_repository=book_repository,
            upload_task_repository=upload_task_repository)
    if response.book_id and not replayed and settings.upload_processing_mode == "background":
        background_tasks.add_task(
            process_upload_task,
            book_id=response.book_id,
            owner_id=current_user.id,
            settings=settings,
            should_update_metadata=False,
            session_factory=request.app.state.db_session_factory,
            task_id=response.task_id,
        )
    return response


@router.post("/source-metadata", response_model=WorkSourceMetadata)
async def get_source_metadata(
    payload: WorkSourceLookupRequest,
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    session: Session = Depends(get_db_session),
) -> WorkSourceMetadata:
    metadata = await fetch_work_source_metadata(payload.url)
    try:
        settings, channel_name = metadata_translation_settings(settings, current_user, session)
    except MetadataProviderConfigurationError as error:
        return metadata.model_copy(update={'translation_status':'unavailable',
            'translation_error_code':error.code,'translation_error_message':str(error)})
    result = await translate_source_metadata(
        metadata, settings, translation_preferences=current_user.ai_translation_prompt or "",
    )
    logging.getLogger(__name__).info('Source metadata source=%s channel=%s model=%s status=%s error_code=%s',
        metadata.source_url, channel_name, settings.ai_translation_model, result.translation_status, result.translation_error_code)
    return result.model_copy(update={'translation_channel':channel_name,'translation_model':settings.ai_translation_model})


@router.post("/books/{book_id}/reprocess", response_model=UploadBookResponse)
def reprocess_book(
    book_id: str,
    background_tasks: BackgroundTasks,
    request: Request,
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
    upload_task_repository: UploadTaskRepository = Depends(get_upload_task_repository),
    session: Session = Depends(get_db_session),
    idempotency_key: UUID | None = Header(default=None),
) -> UploadBookResponse:
    replayed = False
    if idempotency_key:
        from app.modules.uploads.idempotency import create_idempotent_reprocess
        response, replayed = create_idempotent_reprocess(
            session=session, request_id=idempotency_key, owner_id=current_user.id, book_id=book_id)
    else:
        response = create_reprocess_task_for_book(
            owner_id=current_user.id,
            book_id=book_id,
            book_repository=book_repository,
            upload_task_repository=upload_task_repository,
        )
    if not response:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    if not replayed and response.book_id and settings.upload_processing_mode == "background":
        background_tasks.add_task(
            process_upload_task,
            book_id=response.book_id,
            owner_id=current_user.id,
            settings=settings,
            # Reprocessing must never clobber manually edited title/author/description
            # with metadata embedded in the file.
            should_update_metadata=False,
            session_factory=request.app.state.db_session_factory,
            task_id=response.task_id,
        )
    return response


@router.post("/books/{book_id}/replace", response_model=UploadBookResponse)
async def replace_book_file(
    book_id: str,
    background_tasks: BackgroundTasks,
    request: Request,
    file: UploadFile = File(...),
    keep_progress: bool = Form(default=True),
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
    upload_task_repository: UploadTaskRepository = Depends(get_upload_task_repository),
    session: Session = Depends(get_db_session),
    idempotency_key: UUID | None = Header(default=None),
) -> UploadBookResponse:
    replayed = False
    if idempotency_key:
        from app.modules.uploads.idempotency import create_idempotent_replacement
        response, replayed = await create_idempotent_replacement(
            session=session, request_id=idempotency_key, owner_id=current_user.id, book_id=book_id, file=file, keep_progress=keep_progress, settings=settings)
    else:
        response = await create_replace_task_for_book(
            owner_id=current_user.id,
            book_id=book_id,
            file=file,
            keep_progress=keep_progress,
            settings=settings,
            book_repository=book_repository,
            upload_task_repository=upload_task_repository,
        )
    if not response:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    if not replayed and response.book_id and settings.upload_processing_mode == "background":
        background_tasks.add_task(
            process_upload_task,
            book_id=response.book_id,
            owner_id=current_user.id,
            settings=settings,
            should_update_metadata=False,
            session_factory=request.app.state.db_session_factory,
            task_id=response.task_id,
        )
    return response


@router.get("/tasks", response_model=list[UploadTaskPublic])
def get_tasks(
    current_user: User = Depends(get_current_user),
    upload_task_repository: UploadTaskRepository = Depends(get_upload_task_repository),
) -> list[UploadTaskPublic]:
    return list_tasks(current_user.id, upload_task_repository)


@router.delete("/tasks/completed")
def clear_completed_upload_tasks(
    current_user: User = Depends(get_current_user),
    upload_task_repository: UploadTaskRepository = Depends(get_upload_task_repository),
) -> dict[str, int]:
    return {"deleted": clear_finished_tasks(current_user.id, upload_task_repository)}


@router.get("/tasks/{task_id}", response_model=UploadTaskPublic)
def get_upload_task(
    task_id: str,
    current_user: User = Depends(get_current_user),
    upload_task_repository: UploadTaskRepository = Depends(get_upload_task_repository),
) -> UploadTaskPublic:
    task = get_task(current_user.id, task_id, upload_task_repository)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload task not found")
    return task
