import json
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path as PathParam, Query, status
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.security import create_file_ticket
from app.core.dependencies import get_app_settings, get_book_asset_repository, get_book_repository, get_current_user, get_db_session, get_reader_mark_repository, get_reading_progress_repository
from app.modules.book_assets.repository import BookAssetRepository
from app.modules.books.repository import BookRepository
from app.modules.books.service import get_accessible_book
from app.modules.reader.audiobook import get_chapter_audiobook
from app.modules.reader.schemas import ReaderAudiobookTicket, ReaderChapter, ReaderResource, ReaderStartup
from app.modules.reader.service import get_reader_chapter, get_reader_resource, resolve_progress_chapter_position
from app.modules.reader_marks.repository import ReaderMarkRepository
from app.modules.reader_marks.service import list_reader_marks_for_book
from app.modules.reading_progress.repository import ReadingProgressRepository
from app.modules.reading_progress.service import get_progress_for_book
from app.modules.users.domain import User
from app.modules.users.ai_settings import apply_user_audiobook_settings
from app.modules.uploads.source_metadata_settings import MetadataProviderConfigurationError, metadata_translation_settings
from app.modules.japanese.schemas import JapaneseAiTranslationRequest, JapaneseAiTranslationResponse, JapaneseAnnotationRequest, JapaneseAnnotationResponse, JapaneseLookupResponse
from app.modules.japanese.annotations import annotate_japanese_texts
from app.modules.japanese.dictionary import lookup_japanese_text
from app.modules.japanese.service import translate_japanese_texts
from app.modules.translations.ai import ContentFilteredError, ProviderUnavailableError

router = APIRouter(tags=["reader"])
logger = logging.getLogger(__name__)


@router.post("/reader/japanese-ai-translation", response_model=JapaneseAiTranslationResponse)
async def create_japanese_ai_translation(
    payload: JapaneseAiTranslationRequest,
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    session: Session = Depends(get_db_session),
) -> JapaneseAiTranslationResponse:
    try:
        settings, _channel_name = metadata_translation_settings(settings, current_user, session)
    except MetadataProviderConfigurationError as error:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error
    if not settings.ai_translation_api_key or not settings.ai_translation_base_url:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="AI 翻译尚未配置")
    try:
        return await translate_japanese_texts(
            payload.texts,
            settings,
            work_title=payload.work_title,
            chapter_title=payload.chapter_title,
            translation_preferences=current_user.ai_translation_prompt or "",
        )
    except ContentFilteredError as error:
        logger.info("AI translation provider rejected reader text: %s", type(error).__name__)
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="模型因内容政策拒绝了本次请求，请调整文本范围后重试") from error
    except (httpx.HTTPError, json.JSONDecodeError, ProviderUnavailableError, ValueError) as error:
        logger.warning("AI translation provider request failed: %s", type(error).__name__)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="AI 翻译暂时不可用，请稍后重试") from error


@router.post("/reader/japanese-annotations", response_model=JapaneseAnnotationResponse)
def create_japanese_annotations(
    payload: JapaneseAnnotationRequest,
    current_user: User = Depends(get_current_user),
) -> JapaneseAnnotationResponse:
    del current_user
    return annotate_japanese_texts(payload.texts)


@router.get("/reader/japanese-lookup", response_model=JapaneseLookupResponse)
async def get_unsaved_japanese_lookup(
    text: str = Query(min_length=1, max_length=160),
    current_user: User = Depends(get_current_user),
) -> JapaneseLookupResponse:
    del current_user
    return await lookup_japanese_text(text)


@router.get("/{book_id}/reader/japanese-lookup", response_model=JapaneseLookupResponse)
async def get_japanese_lookup(
    book_id: str,
    text: str = Query(min_length=1, max_length=160),
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
) -> JapaneseLookupResponse:
    book = book_repository.get_accessible(current_user.id, book_id)
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return await lookup_japanese_text(text)


@router.get("/{book_id}/reader/startup", response_model=ReaderStartup)
def get_book_reader_startup(
    book_id: str,
    chapter_index: int | None = Query(default=None, ge=1),
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    mark_repository: ReaderMarkRepository = Depends(get_reader_mark_repository),
) -> ReaderStartup:
    book = get_accessible_book(current_user.id, book_id, book_repository, progress_repository)
    resource = get_reader_resource(current_user.id, book_id, book_repository, asset_repository, settings)
    progress = get_progress_for_book(current_user.id, book_id, book_repository, progress_repository)
    marks = list_reader_marks_for_book(book_id=book_id, book_repository=book_repository, mark_repository=mark_repository, user_id=current_user.id, asset_repository=asset_repository)

    if not book or not resource or not progress or marks is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")

    invalid_saved_chapter = bool(resource.toc and progress.chapter_index is not None
                                 and progress.chapter_index not in {item.index for item in resource.toc})
    if resource.toc and (invalid_saved_chapter or (
            chapter_index is None and progress.chapter_index is None and progress.progress_percent > 0)):
        mapped_chapter_index, mapped_chapter_ratio = resolve_progress_chapter_position(
            progress.progress_percent,
            [item.progress_weight for item in resource.toc],
        )
        if mapped_chapter_index is not None:
            progress = progress.model_copy(
                update={
                    "chapter_index": mapped_chapter_index,
                    "epub_cfi": f"aisu-scroll:{mapped_chapter_ratio}" if mapped_chapter_ratio is not None else None,
                    "chapter_href": None,
                }
            )
            if invalid_saved_chapter:
                # Opening a legacy record is not a new reading event. Project
                # the recoverable percentage without rewriting its history.
                book = book.model_copy(update={"current_chapter": f"第 {mapped_chapter_index} 章"})

    resolved_chapter_index = chapter_index or progress.chapter_index or 1
    chapter: ReaderChapter | None = None
    if resource.reader_type not in {"comic", "image", "pdf", "unsupported"} and (resource.chapter_count or 0) > 0:
        chapter = get_reader_chapter(
            asset_repository=asset_repository,
            book_id=book_id,
            book_repository=book_repository,
            chapter_index=resolved_chapter_index,
            owner_id=current_user.id,
            settings=settings,
        )

    return ReaderStartup(book=book, resource=resource, progress=progress, chapter=chapter, marks=marks)


@router.get("/{book_id}/reader", response_model=ReaderResource)
def get_book_reader_resource(
    book_id: str,
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
) -> ReaderResource:
    resource = get_reader_resource(current_user.id, book_id, book_repository, asset_repository, settings)
    if not resource:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return resource


@router.get("/{book_id}/reader/chapters/{chapter_index}", response_model=ReaderChapter)
def get_book_reader_chapter(
    book_id: str,
    chapter_index: int = PathParam(ge=1),
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
) -> ReaderChapter:
    chapter = get_reader_chapter(
        asset_repository=asset_repository,
        book_id=book_id,
        book_repository=book_repository,
        chapter_index=chapter_index,
        owner_id=current_user.id,
        settings=settings,
    )
    if not chapter:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chapter not found")
    return chapter


@router.post("/{book_id}/reader/chapters/{chapter_index}/audiobook", response_model=ReaderAudiobookTicket)
def create_chapter_audiobook_ticket(
    book_id: str,
    chapter_index: int = PathParam(ge=1),
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
) -> ReaderAudiobookTicket:
    settings = apply_user_audiobook_settings(settings, current_user)
    try:
        audiobook = get_chapter_audiobook(
            asset_repository=asset_repository,
            book_id=book_id,
            book_repository=book_repository,
            chapter_index=chapter_index,
            owner_id=current_user.id,
            settings=settings,
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    if not audiobook:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chapter not found")
    purpose = f"audiobook_chapter:{chapter_index}"
    ticket = create_file_ticket(
        subject=current_user.id,
        book_id=book_id,
        purpose=purpose,
        settings=settings,
        expires_minutes=60 * 24,
    )
    return ReaderAudiobookTicket(
        audio_url=f"/api/v1/files/books/{book_id}/audiobooks/{chapter_index}?ticket={ticket}",
        cached=audiobook.cached,
        chapter_index=chapter_index,
        timeline_url=f"/api/v1/files/books/{book_id}/audiobooks/{chapter_index}/timeline?ticket={ticket}",
    )
