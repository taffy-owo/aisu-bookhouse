from uuid import UUID

from fastapi import APIRouter, Depends, File, Header, HTTPException, Path as PathParam, Query, UploadFile, status
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.dependencies import get_app_settings, get_book_asset_repository, get_book_repository, get_current_user, get_db_session, get_public_comment_repository, get_reader_mark_repository, get_reading_progress_repository, get_upload_task_repository, get_user_repository
from app.modules.book_assets.repository import BookAssetRepository
from app.modules.books.repository import BookRepository
from app.modules.books.response_views import BookResponseView
from app.modules.books.chapter_append import append_book_chapter, delete_book_chapter, get_editable_book_chapter, list_editable_book_chapters, update_book_chapter
from app.modules.books.chapter_mutations import parse_chapter_revision
from app.modules.books.cover import COVER_MAX_FILE_BYTES, remove_owned_book_cover, replace_owned_book_cover
from app.modules.books.schemas import BookChapterAppend, BookChapterAppendResult, BookChapterDeleteResult, BookEditableChapter, BookEditableChapterContent, BookListResponse, BookPublic, BookPublicShareRequest, BookReadingStatusResult, BookReadingStatusUpdate, BookShelfOverview, BookSortKey, BookUpdate, SourceCatalogSyncResult, SourceUpdateNotificationList
from app.modules.books.service import cancel_public_share, delete_book, get_accessible_book, get_bookshelf_overview, list_books, list_pending_public_books, list_public_books, moderate_public_share, request_public_share, set_disliked, set_favorite, set_reading_completion, update_book
from app.modules.books.source_catalog import sync_owned_source_catalog
from app.modules.books.source_updates import acknowledge_all_owned_source_updates, acknowledge_owned_source_update, check_owned_source_update, list_owned_source_update_notifications, queue_owned_source_update_translation
from app.modules.comments.repository import PublicCommentRepository
from app.modules.reader_marks.repository import ReaderMarkRepository
from app.modules.reading_progress.repository import ReadingProgressRepository
from app.modules.uploads.repository import UploadTaskRepository
from app.modules.users.domain import User
from app.modules.uploads.source_metadata_settings import MetadataProviderConfigurationError, metadata_translation_settings
from app.modules.users.repository import UserRepository
from app.modules.translations.schemas import WholeBookTranslationJobPublic
from app.modules.translations.service import delete_translation_jobs_for_book, list_book_translation_jobs

router = APIRouter(tags=["books"])


def get_book_response_view(
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    comment_repository: PublicCommentRepository = Depends(get_public_comment_repository),
    user_repository: UserRepository = Depends(get_user_repository),
) -> BookResponseView:
    return BookResponseView(asset_repository, comment_repository, user_repository)


@router.get("", response_model=BookListResponse)
def get_books(
    q: str | None = None,
    kind: str | None = None,
    tag: str | None = None,
    language: str | None = None,
    shelf: str | None = Query(default=None, pattern="^(all|favorite|recent|finished|unread|disliked)$"),
    sort: BookSortKey = "recent",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=24, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
) -> BookListResponse:
    return list_books(
        asset_repository=asset_repository,
        owner_id=current_user.id,
        book_repository=book_repository,
        progress_repository=progress_repository,
        q=q,
        kind=kind,
        tag=tag,
        language=language,
        shelf=shelf,
        sort=sort,
        page=page,
        page_size=page_size,
    )


@router.get("/public", response_model=BookListResponse)
def get_public_books(
    q: str | None = None,
    kind: str | None = None,
    tag: str | None = None,
    language: str | None = None,
    sort: BookSortKey = "recent",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=24, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    comment_repository: PublicCommentRepository = Depends(get_public_comment_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    user_repository: UserRepository = Depends(get_user_repository),
) -> BookListResponse:
    return list_public_books(
        asset_repository=asset_repository,
        book_repository=book_repository,
        progress_repository=progress_repository,
        q=q,
        kind=kind,
        tag=tag,
        language=language,
        sort=sort,
        page=page,
        page_size=page_size,
        viewer_id=current_user.id,
        comment_repository=comment_repository,
        user_repository=user_repository,
    )


@router.get("/public/pending", response_model=BookListResponse)
def get_pending_public_books(
    current_user: User = Depends(get_current_user),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    comment_repository: PublicCommentRepository = Depends(get_public_comment_repository),
    user_repository: UserRepository = Depends(get_user_repository),
) -> BookListResponse:
    require_admin(current_user)
    return list_pending_public_books(asset_repository=asset_repository, book_repository=book_repository, viewer_id=current_user.id, comment_repository=comment_repository, user_repository=user_repository)


@router.get("/source-updates", response_model=SourceUpdateNotificationList)
def get_source_update_notifications(
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
) -> SourceUpdateNotificationList:
    return list_owned_source_update_notifications(
        owner_id=current_user.id,
        book_repository=book_repository,
    )


@router.get("/overview", response_model=BookShelfOverview)
def get_books_overview(
    recent_limit: int = Query(default=24, ge=1, le=48),
    include_labels: bool = Query(default=True),
    current_user: User = Depends(get_current_user),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
) -> BookShelfOverview:
    return get_bookshelf_overview(
        asset_repository=asset_repository,
        owner_id=current_user.id,
        book_repository=book_repository,
        progress_repository=progress_repository,
        recent_limit=recent_limit,
        include_labels=include_labels,
    )


@router.post("/source-updates/acknowledge", response_model=SourceUpdateNotificationList)
def acknowledge_all_source_updates(
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
) -> SourceUpdateNotificationList:
    return acknowledge_all_owned_source_updates(
        owner_id=current_user.id,
        book_repository=book_repository,
    )


@router.get("/{book_id}", response_model=BookPublic)
def get_book_detail(
    book_id: str,
    current_user: User = Depends(get_current_user),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    comment_repository: PublicCommentRepository = Depends(get_public_comment_repository),
    user_repository: UserRepository = Depends(get_user_repository),
) -> BookPublic:
    book = get_accessible_book(current_user.id, book_id, book_repository, progress_repository, comment_repository, user_repository, asset_repository)
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return book


@router.patch("/{book_id}", response_model=BookPublic)
def patch_book(
    book_id: str,
    payload: BookUpdate,
    current_user: User = Depends(get_current_user),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    response_view: BookResponseView = Depends(get_book_response_view),
    settings: Settings = Depends(get_app_settings),
) -> BookPublic:
    book = update_book(current_user.id, book_id, payload, book_repository, progress_repository, asset_repository=asset_repository, settings=settings)
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return response_view.complete(book)


@router.get("/{book_id}/translation-jobs", response_model=list[WholeBookTranslationJobPublic])
def get_book_translation_jobs(
    book_id: str,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
) -> list[WholeBookTranslationJobPublic]:
    jobs = list_book_translation_jobs(current_user.id, book_id, session, offset=offset, limit=limit)
    if jobs is None:
        raise HTTPException(status_code=404, detail="Book not found")
    return jobs


@router.put("/{book_id}/cover", response_model=BookPublic)
async def put_book_cover(
    book_id: str,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    settings: Settings = Depends(get_app_settings),
    response_view: BookResponseView = Depends(get_book_response_view),
) -> BookPublic:
    data = await file.read(COVER_MAX_FILE_BYTES + 1)
    if len(data) > COVER_MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="封面不能超过 10 MB")
    try:
        book = replace_owned_book_cover(
            asset_repository=asset_repository,
            book_id=book_id,
            book_repository=book_repository,
            data=data,
            owner_id=current_user.id,
            progress_repository=progress_repository,
            settings=settings,
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return response_view.complete(book)


@router.delete("/{book_id}/cover", response_model=BookPublic)
def delete_book_cover(
    book_id: str,
    current_user: User = Depends(get_current_user),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    settings: Settings = Depends(get_app_settings),
    response_view: BookResponseView = Depends(get_book_response_view),
) -> BookPublic:
    book = remove_owned_book_cover(
        asset_repository=asset_repository,
        book_id=book_id,
        book_repository=book_repository,
        owner_id=current_user.id,
        progress_repository=progress_repository,
        settings=settings,
    )
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return response_view.complete(book)


@router.post("/{book_id}/source-update/check", response_model=BookPublic)
async def check_book_source_update(
    book_id: str,
    current_user: User = Depends(get_current_user),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
    response_view: BookResponseView = Depends(get_book_response_view),
) -> BookPublic:
    try:
        book = await check_owned_source_update(
            owner_id=current_user.id,
            book_id=book_id,
            asset_repository=asset_repository,
            book_repository=book_repository,
            progress_repository=progress_repository,
            session=session,
            settings=settings,
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return response_view.complete(book)


@router.post("/{book_id}/source-update/acknowledge", response_model=BookPublic)
def acknowledge_book_source_update(
    book_id: str,
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    response_view: BookResponseView = Depends(get_book_response_view),
) -> BookPublic:
    book = acknowledge_owned_source_update(
        owner_id=current_user.id,
        book_id=book_id,
        book_repository=book_repository,
        progress_repository=progress_repository,
    )
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return response_view.complete(book)


@router.post(
    "/{book_id}/source-update/translate",
    response_model=WholeBookTranslationJobPublic,
    status_code=status.HTTP_202_ACCEPTED,
)
async def translate_book_source_update(
    book_id: str,
    current_user: User = Depends(get_current_user),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> WholeBookTranslationJobPublic:
    try:
        job = await queue_owned_source_update_translation(
            owner_id=current_user.id,
            book_id=book_id,
            asset_repository=asset_repository,
            book_repository=book_repository,
            session=session,
            settings=settings,
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return job


@router.post("/{book_id}/source-catalog/sync", response_model=SourceCatalogSyncResult)
async def sync_book_source_catalog(
    book_id: str,
    current_user: User = Depends(get_current_user),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> SourceCatalogSyncResult:
    try:
        effective_settings, _channel_name = metadata_translation_settings(settings, current_user, session)
        result = await sync_owned_source_catalog(
            owner_id=current_user.id,
            book_id=book_id,
            book_repository=book_repository,
            asset_repository=asset_repository,
            settings=effective_settings,
        )
    except MetadataProviderConfigurationError as error:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    if not result:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return result


@router.post("/{book_id}/chapters", response_model=BookChapterAppendResult)
def append_chapter(
    book_id: str,
    payload: BookChapterAppend,
    request_id: UUID | None = Header(default=None, alias='Idempotency-Key'),
    current_user: User = Depends(get_current_user),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    settings: Settings = Depends(get_app_settings),
) -> BookChapterAppendResult:
    result = append_book_chapter(
        owner_id=current_user.id,
        book_id=book_id,
        payload=payload,
        request_id=request_id,
        book_repository=book_repository,
        asset_repository=asset_repository,
        progress_repository=progress_repository,
        settings=settings,
    )
    if not result:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return result


@router.get("/{book_id}/chapters", response_model=list[BookEditableChapter])
def get_editable_chapters(
    book_id: str,
    current_user: User = Depends(get_current_user),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    settings: Settings = Depends(get_app_settings),
) -> list[BookEditableChapter]:
    chapters = list_editable_book_chapters(
        owner_id=current_user.id,
        book_id=book_id,
        book_repository=book_repository,
        asset_repository=asset_repository,
        settings=settings,
    )
    if chapters is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return chapters


@router.get("/{book_id}/chapters/{chapter_index}/edit", response_model=BookEditableChapterContent)
def get_editable_chapter_content(
    book_id: str,
    chapter_index: int = PathParam(ge=1),
    current_user: User = Depends(get_current_user),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    settings: Settings = Depends(get_app_settings),
) -> BookEditableChapterContent:
    chapter = get_editable_book_chapter(
        owner_id=current_user.id,
        book_id=book_id,
        chapter_index=chapter_index,
        book_repository=book_repository,
        asset_repository=asset_repository,
        settings=settings,
    )
    if chapter is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return chapter


@router.put("/{book_id}/chapters/{chapter_index}", response_model=BookChapterAppendResult)
def edit_chapter(
    book_id: str,
    payload: BookChapterAppend,
    chapter_index: int = PathParam(ge=1),
    request_id: UUID | None = Header(default=None, alias='Idempotency-Key'),
    if_match: str | None = Header(default=None),
    current_user: User = Depends(get_current_user),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    mark_repository: ReaderMarkRepository = Depends(get_reader_mark_repository),
    settings: Settings = Depends(get_app_settings),
) -> BookChapterAppendResult:
    result = update_book_chapter(
        owner_id=current_user.id,
        book_id=book_id,
        chapter_index=chapter_index,
        payload=payload,
        request_id=request_id,
        expected_revision=parse_chapter_revision(if_match),
        book_repository=book_repository,
        asset_repository=asset_repository,
        progress_repository=progress_repository,
        mark_repository=mark_repository,
        settings=settings,
    )
    if not result:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return result


@router.delete("/{book_id}/chapters/{chapter_index}", response_model=BookChapterDeleteResult)
def remove_chapter(
    book_id: str,
    chapter_index: int = PathParam(ge=1),
    request_id: UUID | None = Header(default=None, alias='Idempotency-Key'),
    if_match: str | None = Header(default=None),
    current_user: User = Depends(get_current_user),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    mark_repository: ReaderMarkRepository = Depends(get_reader_mark_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    settings: Settings = Depends(get_app_settings),
) -> BookChapterDeleteResult:
    result = delete_book_chapter(
        owner_id=current_user.id,
        book_id=book_id,
        chapter_index=chapter_index,
        request_id=request_id,
        expected_revision=parse_chapter_revision(if_match),
        book_repository=book_repository,
        asset_repository=asset_repository,
        mark_repository=mark_repository,
        progress_repository=progress_repository,
        settings=settings,
    )
    if not result:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return result


@router.delete("/{book_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_book(
    book_id: str,
    current_user: User = Depends(get_current_user),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    mark_repository: ReaderMarkRepository = Depends(get_reader_mark_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    upload_task_repository: UploadTaskRepository = Depends(get_upload_task_repository),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> None:
    if not delete_book(current_user.id, book_id, book_repository, asset_repository, mark_repository, progress_repository, upload_task_repository, settings):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    delete_translation_jobs_for_book(current_user.id, book_id, session, settings)


@router.put("/{book_id}/reading-status", response_model=BookReadingStatusResult)
def set_book_reading_status(
    book_id: str,
    payload: BookReadingStatusUpdate,
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    response_view: BookResponseView = Depends(get_book_response_view),
) -> BookReadingStatusResult:
    book = set_reading_completion(current_user.id, book_id, payload.finished, book_repository, progress_repository, updated_at=payload.updated_at)
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return BookReadingStatusResult.model_validate(response_view.complete(book))


@router.post("/{book_id}/favorite", response_model=BookPublic)
def favorite_book(
    book_id: str,
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    response_view: BookResponseView = Depends(get_book_response_view),
) -> BookPublic:
    book = set_favorite(current_user.id, book_id, True, book_repository, progress_repository)
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return response_view.complete(book)


@router.delete("/{book_id}/favorite", response_model=BookPublic)
def unfavorite_book(
    book_id: str,
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    response_view: BookResponseView = Depends(get_book_response_view),
) -> BookPublic:
    book = set_favorite(current_user.id, book_id, False, book_repository, progress_repository)
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return response_view.complete(book)


@router.post("/{book_id}/dislike", response_model=BookPublic)
def dislike_book(
    book_id: str,
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    response_view: BookResponseView = Depends(get_book_response_view),
) -> BookPublic:
    book = set_disliked(current_user.id, book_id, True, book_repository, progress_repository)
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return response_view.complete(book)


@router.delete("/{book_id}/dislike", response_model=BookPublic)
def restore_disliked_book(
    book_id: str,
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    response_view: BookResponseView = Depends(get_book_response_view),
) -> BookPublic:
    book = set_disliked(current_user.id, book_id, False, book_repository, progress_repository)
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return response_view.complete(book)


@router.post("/{book_id}/share-request", response_model=BookPublic)
def share_book_to_public_library(
    book_id: str,
    payload: BookPublicShareRequest | None = None,
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    response_view: BookResponseView = Depends(get_book_response_view),
) -> BookPublic:
    book = request_public_share(current_user.id, book_id, payload or BookPublicShareRequest(), book_repository, progress_repository)
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ready book not found")
    return response_view.complete(book)


@router.delete("/{book_id}/share-request", response_model=BookPublic)
def remove_book_from_public_library(
    book_id: str,
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    response_view: BookResponseView = Depends(get_book_response_view),
) -> BookPublic:
    book = cancel_public_share(current_user.id, book_id, book_repository, progress_repository)
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return response_view.complete(book)


@router.post("/{book_id}/share-request/approve", response_model=BookPublic)
def approve_public_book(
    book_id: str,
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    response_view: BookResponseView = Depends(get_book_response_view),
) -> BookPublic:
    require_admin(current_user)
    book = moderate_public_share(book_id=book_id, book_repository=book_repository, moderator_id=current_user.id, progress_repository=progress_repository, approve=True)
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return response_view.complete(book)


@router.post("/{book_id}/share-request/reject", response_model=BookPublic)
def reject_public_book(
    book_id: str,
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    response_view: BookResponseView = Depends(get_book_response_view),
) -> BookPublic:
    require_admin(current_user)
    book = moderate_public_share(book_id=book_id, book_repository=book_repository, moderator_id=current_user.id, progress_repository=progress_repository, approve=False)
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return response_view.complete(book)


def require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
