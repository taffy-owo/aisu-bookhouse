from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path as PathParam, Response
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.dependencies import get_current_user, get_db_session, get_app_settings
from app.modules.book_assets.repository import SqlAlchemyBookAssetRepository
from app.modules.books.continuation import ContinuationChapter, ContinuationRequest, ContinuationResult, ContinuationState, append_chapters, continuation_state
from app.modules.books.original_chapter_editor import read_raw_editable_content
from app.modules.reader.service import filter_readable_text_assets
from app.modules.users.domain import User
from app.modules.books.translation_context import TranslationContextState, TranslationContextEdit, translation_context_state, edit_translation_context

router = APIRouter(tags=["book-continuation"])


@router.get("/{book_id}/translation-context", response_model=TranslationContextState)
def get_translation_context(book_id: UUID, response: Response, user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session)):
    response.headers["Cache-Control"] = "no-store"
    return translation_context_state(session, user.id, str(book_id))


@router.patch("/{book_id}/translation-context", response_model=TranslationContextState)
def patch_translation_context(book_id: UUID, payload: TranslationContextEdit, response: Response,
    user: User = Depends(get_current_user), session: Session = Depends(get_db_session)):
    response.headers["Cache-Control"] = "no-store"
    return edit_translation_context(session, user.id, str(book_id), payload)


class ContinuationContent(ContinuationChapter):
    index: int
    content_hash: str | None = None
    has_images: bool


@router.get("/{book_id}/continuation", response_model=ContinuationState)
def get_state(book_id: UUID, response: Response, user: User = Depends(get_current_user), session: Session = Depends(get_db_session)):
    state = continuation_state(session, user.id, str(book_id))
    response.headers["ETag"] = f'"{state.revision}"'
    response.headers["Cache-Control"] = "no-store"
    return state


@router.get("/{book_id}/continuation/chapters/{chapter_index}", response_model=ContinuationContent)
def get_content(book_id: UUID, response: Response, chapter_index: int = PathParam(ge=1), user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session), settings: Settings = Depends(get_app_settings)):
    state = continuation_state(session, user.id, str(book_id))
    if chapter_index < 1 or chapter_index > state.chapter_count:
        raise HTTPException(404, "Chapter not found")
    entry = state.chapters[chapter_index - 1]
    asset = filter_readable_text_assets(SqlAlchemyBookAssetRepository(session).list_by_book(str(book_id), "text_chapter"))[chapter_index - 1]
    response.headers["Cache-Control"] = "no-store"
    content = read_raw_editable_content(asset, entry.title, settings)
    return ContinuationContent(index=entry.index, title=entry.title, content=content,
        source_id=entry.source_id, source_url=entry.source_url, content_hash=entry.content_hash,
        has_images="[[AISU_CHAPTER_IMAGE:" in content)


@router.post("/{book_id}/continuation", response_model=ContinuationResult)
def append(book_id: UUID, payload: ContinuationRequest, response: Response, user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session), settings: Settings = Depends(get_app_settings)):
    response.headers["Cache-Control"] = "no-store"
    return append_chapters(session=session, owner_id=user.id, book_id=str(book_id), chapters=payload.chapters,
        settings=settings, request_id=payload.request_id, expected_revision=payload.expected_revision)
