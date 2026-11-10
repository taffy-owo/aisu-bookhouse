from fastapi import APIRouter, Depends, HTTPException, status

from app.core.dependencies import get_book_repository, get_book_asset_repository, get_current_user, get_reading_progress_repository
from app.modules.book_assets.repository import BookAssetRepository
from app.modules.books.repository import BookRepository
from app.modules.reading_progress.repository import ReadingProgressRepository
from app.modules.reading_progress.schemas import ReadingProgressPublic, ReadingProgressUpdate
from app.modules.reading_progress.service import get_progress_for_book, save_progress_for_book
from app.modules.users.domain import User

router = APIRouter(tags=["reading-progress"])


@router.get("/{book_id}/progress", response_model=ReadingProgressPublic)
def get_progress(
    book_id: str,
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
) -> ReadingProgressPublic:
    progress = get_progress_for_book(current_user.id, book_id, book_repository, progress_repository)
    if not progress:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return progress


@router.put("/{book_id}/progress", response_model=ReadingProgressPublic, responses={409: {"description": "阅读文件或坐标已更新，或页码缺少当前文件标识。请刷新阅读资源后重试。"}})
def put_progress(
    book_id: str,
    payload: ReadingProgressUpdate,
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    progress_repository: ReadingProgressRepository = Depends(get_reading_progress_repository),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
) -> ReadingProgressPublic:
    progress = save_progress_for_book(current_user.id, book_id, payload, book_repository, progress_repository, asset_repository)
    if not progress:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return progress
