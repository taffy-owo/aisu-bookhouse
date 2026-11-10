from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.dependencies import get_book_repository, get_current_user, get_public_comment_repository, get_user_repository
from app.modules.books.repository import BookRepository
from app.modules.comments.repository import PublicCommentRepository
from app.modules.comments.schemas import PublicCommentCreate, PublicCommentListResponse, PublicCommentPublic
from app.modules.comments.service import create_comment, delete_comment, list_comments
from app.modules.users.domain import User
from app.modules.users.repository import UserRepository

router = APIRouter(tags=["comments"])


@router.get("/{book_id}/comments", response_model=PublicCommentListResponse)
def get_book_comments(
    book_id: str,
    target_type: str = Query(default="book", pattern="^(book|volume)$"),
    target_index: int | None = Query(default=None, ge=1),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    comment_repository: PublicCommentRepository = Depends(get_public_comment_repository),
    user_repository: UserRepository = Depends(get_user_repository),
) -> PublicCommentListResponse:
    comments = list_comments(
        book_id=book_id,
        book_repository=book_repository,
        comment_repository=comment_repository,
        target_type=target_type,
        target_index=target_index,
        user_repository=user_repository,
        limit=limit,
        offset=offset,
    )
    if comments is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Public book not found")
    return comments


@router.post("/{book_id}/comments", response_model=PublicCommentPublic)
def post_book_comment(
    book_id: str,
    payload: PublicCommentCreate,
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    comment_repository: PublicCommentRepository = Depends(get_public_comment_repository),
) -> PublicCommentPublic:
    comment = create_comment(
        book_id=book_id,
        book_repository=book_repository,
        comment_repository=comment_repository,
        current_user=current_user,
        payload=payload,
    )
    if not comment:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Public book not found")
    return comment


@router.delete("/{book_id}/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_book_comment(
    book_id: str,
    comment_id: str,
    current_user: User = Depends(get_current_user),
    comment_repository: PublicCommentRepository = Depends(get_public_comment_repository),
) -> None:
    if not delete_comment(book_id=book_id, comment_id=comment_id, comment_repository=comment_repository, current_user=current_user):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Comment not found")
