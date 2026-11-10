import logging
from typing import Literal

from PIL import UnidentifiedImageError
from fastapi import APIRouter, Depends, HTTPException, Path as PathParam, Query, status
from fastapi.responses import FileResponse, Response, StreamingResponse

from app.core.config import Settings
from app.core.dependencies import get_app_settings, get_book_asset_repository, get_book_repository, get_current_user, get_user_repository
from app.core.security import create_file_ticket, decode_file_ticket
from app.modules.book_assets.repository import BookAssetRepository
from app.modules.books.repository import BookRepository
from app.modules.books.cover_variants import cover_variant_path
from app.modules.files.service import get_asset_file_download, get_original_file_download
from app.modules.reader.audiobook import get_audiobook_timeline, get_chapter_audiobook, stream_chapter_audiobook
from app.modules.reader.schemas import ReaderAudiobookTimeline
from app.modules.users.avatar import get_or_create_avatar_derivative
from app.modules.users.domain import User
from app.modules.users.repository import UserRepository
from app.modules.users.ai_settings import apply_user_audiobook_settings

router = APIRouter(tags=["files"])
logger = logging.getLogger(__name__)


@router.get("/books/{book_id}/original")
def get_original_file(
    book_id: str,
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
) -> FileResponse:
    download = get_original_file_download(book_id=book_id, book_repository=book_repository, owner_id=current_user.id, respect_public_download_policy=True, settings=settings)
    if not download:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    return FileResponse(
        path=download.path,
        media_type=download.media_type,
        filename=download.file_name,
        headers={"Cache-Control": "private, max-age=0"},
    )


@router.get("/books/{book_id}/epub")
def get_epub_file(
    book_id: str,
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
) -> FileResponse:
    download = get_original_file_download(
        allowed_reader_types={"epub"},
        book_id=book_id,
        book_repository=book_repository,
        owner_id=current_user.id,
        respect_public_download_policy=True,
        settings=settings,
    )
    if not download:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    return FileResponse(
        path=download.path,
        media_type=download.media_type,
        filename=download.file_name,
        headers={"Cache-Control": "private, max-age=0"},
    )


@router.get("/books/{book_id}/pdf")
def get_pdf_file(
    book_id: str,
    position_key: str | None = Query(default=None, min_length=1, max_length=128),
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
) -> FileResponse:
    download = get_original_file_download(
        allowed_reader_types={"pdf"},
        book_id=book_id,
        book_repository=book_repository,
        owner_id=current_user.id,
        respect_public_download_policy=True,
        settings=settings,
        position_key=position_key,
    )
    if not download:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    return FileResponse(
        path=download.path,
        media_type=download.media_type,
        filename=download.file_name,
        headers={"Cache-Control": "private, max-age=0"},
    )


@router.get("/books/{book_id}/pdf-preview")
def get_pdf_preview_file(
    book_id: str,
    position_key: str | None = Query(default=None, min_length=1, max_length=128),
    ticket: str = Query(min_length=20),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
    user_repository: UserRepository = Depends(get_user_repository),
) -> FileResponse:
    """Stream PDFs through a scoped URL so native viewers can use Range requests."""
    user_id, ticket_book_id, purpose = decode_file_ticket(ticket, settings)
    user = user_repository.get_by_id(user_id)
    if ticket_book_id != book_id or purpose != "pdf_preview" or not user or user.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid file ticket")

    # Public sharing's download switch controls saving the original, not
    # in-site reading. Accessibility is still rechecked for the ticket owner.
    download = get_original_file_download(
        allowed_reader_types={"pdf"},
        book_id=book_id,
        book_repository=book_repository,
        owner_id=user_id,
        respect_public_download_policy=False,
        settings=settings,
        position_key=position_key,
    )
    if not download:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    return FileResponse(
        path=download.path,
        media_type="application/pdf",
        filename=download.file_name,
        content_disposition_type="inline",
        headers={"Cache-Control": "private, no-store"},
    )


@router.post("/books/{book_id}/download-ticket")
def create_original_download_ticket(
    book_id: str,
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
) -> dict[str, str]:
    download = get_original_file_download(
        book_id=book_id,
        book_repository=book_repository,
        owner_id=current_user.id,
        respect_public_download_policy=True,
        settings=settings,
    )
    if not download:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    ticket = create_file_ticket(
        subject=current_user.id,
        book_id=book_id,
        purpose="original_download",
        settings=settings,
        expires_minutes=5,
    )
    return {"url": f"/api/v1/files/books/{book_id}/download?ticket={ticket}"}


@router.get("/books/{book_id}/download")
def download_original_with_ticket(
    book_id: str,
    ticket: str = Query(min_length=20),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
    user_repository: UserRepository = Depends(get_user_repository),
) -> FileResponse:
    user_id, ticket_book_id, purpose = decode_file_ticket(ticket, settings)
    user = user_repository.get_by_id(user_id)
    if ticket_book_id != book_id or purpose != "original_download" or not user or user.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid file ticket")
    download = get_original_file_download(
        book_id=book_id,
        book_repository=book_repository,
        owner_id=user_id,
        respect_public_download_policy=True,
        settings=settings,
    )
    if not download:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    return FileResponse(
        path=download.path,
        media_type=download.media_type,
        filename=download.file_name,
        headers={"Cache-Control": "private, no-store"},
    )


@router.get("/books/{book_id}/cover")
def get_book_cover_file(
    book_id: str,
    size: Literal["original", "small", "medium", "large"] = "original",
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
) -> FileResponse:
    download = get_asset_file_download(
        asset_repository=asset_repository,
        asset_type="cover",
        book_id=book_id,
        book_repository=book_repository,
        file_name=f"{book_id}-cover",
        owner_id=current_user.id,
        settings=settings,
    )
    if not download:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    path = download.path
    media_type = download.media_type
    if size != "original":
        try:
            path = cover_variant_path(path, size, settings)
            media_type = "image/webp"
        except (OSError, ValueError, UnidentifiedImageError):
            # A damaged legacy cover can still be inspected through the original endpoint.
            path = download.path
    return FileResponse(
        path=path,
        media_type=media_type,
        headers={"Cache-Control": "private, max-age=300"},
    )


@router.get("/books/{book_id}/audiobooks/{chapter_index}")
async def get_book_audiobook_file(
    book_id: str,
    chapter_index: int = PathParam(ge=1),
    ticket: str = Query(min_length=20),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    user_repository: UserRepository = Depends(get_user_repository),
) -> Response:
    user_id, ticket_book_id, purpose = decode_file_ticket(ticket, settings)
    user = user_repository.get_by_id(user_id)
    if ticket_book_id != book_id or purpose != f"audiobook_chapter:{chapter_index}" or not user or user.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid file ticket")
    settings = apply_user_audiobook_settings(settings, user)
    try:
        audiobook = get_chapter_audiobook(
            asset_repository=asset_repository,
            book_id=book_id,
            book_repository=book_repository,
            chapter_index=chapter_index,
            owner_id=user_id,
            settings=settings,
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    if not audiobook:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audiobook not found")
    if not audiobook.cached:
        async def stream_audio():
            try:
                async for data in stream_chapter_audiobook(audiobook, settings):
                    yield data
            except Exception:
                logger.warning("Audiobook streaming failed for book %s chapter %s", book_id, chapter_index, exc_info=True)
                raise

        return StreamingResponse(
            stream_audio(),
            media_type=audiobook.media_type,
            headers={
                "Cache-Control": "private, no-store",
                "Content-Disposition": f'inline; filename="chapter-{chapter_index}{audiobook.path.suffix}"',
                "X-Accel-Buffering": "no",
            },
        )

    return FileResponse(
        path=audiobook.path,
        media_type=audiobook.media_type,
        filename=f"chapter-{chapter_index}{audiobook.path.suffix}",
        content_disposition_type="inline",
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.get("/books/{book_id}/audiobooks/{chapter_index}/timeline", response_model=ReaderAudiobookTimeline)
def get_book_audiobook_timeline(
    book_id: str,
    chapter_index: int = PathParam(ge=1),
    ticket: str = Query(min_length=20),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    user_repository: UserRepository = Depends(get_user_repository),
) -> ReaderAudiobookTimeline:
    user_id, ticket_book_id, purpose = decode_file_ticket(ticket, settings)
    user = user_repository.get_by_id(user_id)
    if ticket_book_id != book_id or purpose != f"audiobook_chapter:{chapter_index}" or not user or user.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid file ticket")
    settings = apply_user_audiobook_settings(settings, user)
    audiobook = get_chapter_audiobook(
        asset_repository=asset_repository,
        book_id=book_id,
        book_repository=book_repository,
        chapter_index=chapter_index,
        owner_id=user_id,
        settings=settings,
    )
    if not audiobook:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audiobook not found")
    return ReaderAudiobookTimeline.model_validate(get_audiobook_timeline(audiobook))


@router.get("/books/{book_id}/pages/{page_index}")
def get_book_page_file(
    book_id: str,
    position_key: str | None = Query(default=None, min_length=1, max_length=128),
    page_index: int = PathParam(ge=1),
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
) -> FileResponse:
    download = get_asset_file_download(
        asset_repository=asset_repository,
        asset_type="comic_page",
        book_id=book_id,
        book_repository=book_repository,
        file_name=f"{book_id}-page-{page_index}",
        index=page_index,
        owner_id=current_user.id,
        settings=settings,
        position_key=position_key,
    ) or get_asset_file_download(
        asset_repository=asset_repository,
        asset_type="image_page",
        book_id=book_id,
        book_repository=book_repository,
        file_name=f"{book_id}-page-{page_index}",
        index=page_index,
        owner_id=current_user.id,
        settings=settings,
        position_key=position_key,
    )
    if not download:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    return FileResponse(
        path=download.path,
        media_type=download.media_type,
        headers={"Cache-Control": "private, max-age=300"},
    )


@router.get("/books/{book_id}/chapter-images/{image_index}")
def get_book_chapter_image_file(
    book_id: str,
    image_index: int = PathParam(ge=1),
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    book_repository: BookRepository = Depends(get_book_repository),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
) -> FileResponse:
    download = get_asset_file_download(
        asset_repository=asset_repository,
        asset_type="chapter_image",
        book_id=book_id,
        book_repository=book_repository,
        file_name=f"{book_id}-chapter-image-{image_index}",
        index=image_index,
        owner_id=current_user.id,
        settings=settings,
    )
    if not download:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    return FileResponse(
        path=download.path,
        media_type=download.media_type,
        headers={"Cache-Control": "private, max-age=300"},
    )


@router.get("/users/{user_id}/avatar")
def get_user_avatar(
    user_id: str,
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
    user_repository: UserRepository = Depends(get_user_repository),
) -> FileResponse:
    user = user_repository.get_by_id(user_id)
    if not user or not user.avatar:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Avatar not found")

    from app.core.storage import get_storage_root, resolve_storage_path

    try:
        source_path = resolve_storage_path(get_storage_root(settings), user.avatar)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Avatar not found")

    if not source_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Avatar not found")

    try:
        path = get_or_create_avatar_derivative(source_relative_path=user.avatar, user_id=user.id, settings=settings)
    except Exception as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Avatar not found") from error

    return FileResponse(
        path=path,
        media_type="image/webp",
        # Authenticated resource: keep caching browser-private. The URL carries
        # an avatar-version query param, so a long max-age is still safe.
        headers={"Cache-Control": "private, max-age=86400"},
    )
