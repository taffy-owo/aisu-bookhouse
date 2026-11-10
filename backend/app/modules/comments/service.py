from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException, status

from app.modules.books.domain import Book
from app.modules.books.repository import BookRepository, is_publicly_available
from app.modules.comments.domain import PublicComment
from app.modules.comments.repository import PublicCommentRepository
from app.modules.comments.schemas import PublicCommentCreate, PublicCommentListResponse, PublicCommentPublic
from app.modules.users.domain import User
from app.modules.users.repository import UserRepository


def list_comments(
    *,
    book_id: str,
    book_repository: BookRepository,
    comment_repository: PublicCommentRepository,
    target_type: str,
    target_index: int | None,
    user_repository: UserRepository,
    limit: int = 100,
    offset: int = 0,
) -> PublicCommentListResponse | None:
    book = get_public_book(book_id, book_repository)
    if not book:
        return None
    validate_target(target_type, target_index)

    total = comment_repository.count_for_target(book.id, target_type, target_index)
    comments = comment_repository.list_for_target(book.id, target_type, target_index, limit=limit, offset=offset)
    users = {user.id: user for user in user_repository.list_by_ids(list({comment.user_id for comment in comments}))}
    return PublicCommentListResponse(items=[to_public(comment, users.get(comment.user_id)) for comment in comments], total=total)


def create_comment(
    *,
    book_id: str,
    book_repository: BookRepository,
    comment_repository: PublicCommentRepository,
    current_user: User,
    payload: PublicCommentCreate,
) -> PublicCommentPublic | None:
    book = get_public_book(book_id, book_repository)
    if not book:
        return None
    validate_target(payload.target_type, payload.target_index)

    body = payload.body.strip()
    if not body:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Comment cannot be empty")

    now = datetime.now(timezone.utc)
    comment = comment_repository.save(
        PublicComment(
            id=str(uuid4()),
            book_id=book.id,
            user_id=current_user.id,
            target_type=payload.target_type,
            target_index=payload.target_index,
            body=body,
            created_at=now,
            updated_at=now,
        )
    )
    return to_public(comment, current_user)


def delete_comment(*, book_id: str, comment_id: str, comment_repository: PublicCommentRepository, current_user: User) -> bool:
    comment = comment_repository.get(comment_id)
    if not comment or comment.book_id != book_id:
        return False
    if comment.user_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can only delete your own comments")

    comment_repository.save(comment.with_changes(deleted_at=datetime.now(timezone.utc)))
    return True


def get_public_book(book_id: str, book_repository: BookRepository) -> Book | None:
    book = book_repository.get_by_id(book_id)
    if not book or not is_publicly_available(book):
        return None
    return book


def validate_target(target_type: str, target_index: int | None) -> None:
    if target_type == "book" and target_index is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Book comments cannot include a target index")
    if target_type == "volume" and target_index is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Volume comments need a target index")


def to_public(comment: PublicComment, user: User | None) -> PublicCommentPublic:
    return PublicCommentPublic(
        id=comment.id,
        book_id=comment.book_id,
        user_id=comment.user_id,
        user_nickname=user.nickname if user else "读者",
        target_type=comment.target_type,
        target_index=comment.target_index,
        body=comment.body,
        created_at=comment.created_at,
        updated_at=comment.updated_at,
    )
