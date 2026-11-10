from fastapi import APIRouter, Depends, HTTPException, status

from app.core.dependencies import get_book_repository, get_book_asset_repository, get_current_user, get_reader_mark_repository
from app.modules.book_assets.repository import BookAssetRepository
from app.modules.books.repository import BookRepository
from app.modules.reader_marks.repository import ReaderMarkRepository
from app.modules.reader_marks.schemas import ReaderMarkCreate, ReaderMarkPublic, ReaderMarkRelocate, ReaderMarkUpdate
from app.modules.reader_marks.service import create_reader_mark_for_book, delete_reader_mark, list_reader_marks_for_book, relocate_reader_mark_for_book, update_reader_mark
from app.modules.users.domain import User

router = APIRouter(tags=["reader-marks"])


@router.get("/{book_id}/marks", response_model=list[ReaderMarkPublic])
def get_reader_marks(
    book_id: str,
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    mark_repository: ReaderMarkRepository = Depends(get_reader_mark_repository),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
) -> list[ReaderMarkPublic]:
    marks = list_reader_marks_for_book(book_id=book_id, book_repository=book_repository, mark_repository=mark_repository, user_id=current_user.id, asset_repository=asset_repository)
    if marks is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return marks


@router.post("/{book_id}/marks", response_model=ReaderMarkPublic, status_code=status.HTTP_201_CREATED, responses={409: {"description": "阅读文件或坐标已更新，或页码缺少当前文件标识。请刷新阅读资源后重试。"}})
def post_reader_mark(
    book_id: str,
    payload: ReaderMarkCreate,
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    mark_repository: ReaderMarkRepository = Depends(get_reader_mark_repository),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
) -> ReaderMarkPublic:
    mark = create_reader_mark_for_book(book_id=book_id, book_repository=book_repository, mark_repository=mark_repository, payload=payload, user_id=current_user.id, asset_repository=asset_repository)
    if mark is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return mark


@router.patch("/{book_id}/marks/{mark_id}", response_model=ReaderMarkPublic, responses={409: {"description": "书籍正在更新，请刷新后重试；原笔记保留。"}})
def patch_reader_mark(
    book_id: str,
    mark_id: str,
    payload: ReaderMarkUpdate,
    current_user: User = Depends(get_current_user),
    mark_repository: ReaderMarkRepository = Depends(get_reader_mark_repository),
    book_repository: BookRepository = Depends(get_book_repository),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
) -> ReaderMarkPublic:
    mark = update_reader_mark(book_id=book_id, mark_id=mark_id, mark_repository=mark_repository, book_repository=book_repository, payload=payload, user_id=current_user.id, asset_repository=asset_repository)
    if mark is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reader mark not found")
    return mark


@router.put("/{book_id}/marks/{mark_id}/position", response_model=ReaderMarkPublic, responses={409: {"description": "目标正文、格式或坐标已更新；原笔记及定位均未修改。"}})
def put_reader_mark_position(
    book_id: str, mark_id: str, payload: ReaderMarkRelocate,
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    asset_repository: BookAssetRepository = Depends(get_book_asset_repository),
    mark_repository: ReaderMarkRepository = Depends(get_reader_mark_repository),
) -> ReaderMarkPublic:
    mark = relocate_reader_mark_for_book(book_id=book_id, mark_id=mark_id, user_id=current_user.id, payload=payload,
                                         book_repository=book_repository, asset_repository=asset_repository, mark_repository=mark_repository)
    if mark is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reader mark not found")
    return mark


@router.delete("/{book_id}/marks/{mark_id}", status_code=status.HTTP_204_NO_CONTENT, responses={409: {"description": "书籍正在更新，请刷新后重试；原笔记保留。"}})
def remove_reader_mark(
    book_id: str,
    mark_id: str,
    current_user: User = Depends(get_current_user),
    mark_repository: ReaderMarkRepository = Depends(get_reader_mark_repository),
    book_repository: BookRepository = Depends(get_book_repository),
) -> None:
    if not delete_reader_mark(book_id=book_id, mark_id=mark_id, mark_repository=mark_repository, book_repository=book_repository, user_id=current_user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reader mark not found")
