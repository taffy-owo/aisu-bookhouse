from collections.abc import Generator
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.security import decode_access_token
from app.modules.auth.sessions import session_is_active
from app.modules.book_assets.repository import BookAssetRepository, SqlAlchemyBookAssetRepository
from app.modules.books.repository import BookRepository, SqlAlchemyBookRepository
from app.modules.comments.repository import PublicCommentRepository, SqlAlchemyPublicCommentRepository
from app.modules.invitations.repository import InvitationRepository, SqlAlchemyInvitationRepository
from app.modules.reader_marks.repository import ReaderMarkRepository, SqlAlchemyReaderMarkRepository
from app.modules.reading_activity.repository import ReadingActivityRepository, SqlAlchemyReadingActivityRepository
from app.modules.reading_progress.repository import ReadingProgressRepository, SqlAlchemyReadingProgressRepository
from app.modules.uploads.repository import SqlAlchemyUploadTaskRepository, UploadTaskRepository
from app.modules.users.domain import User
from app.modules.users.repository import SqlAlchemyUserRepository, UserRepository


def get_db_session(request: Request) -> Generator[Session, None, None]:
    session_factory = request.app.state.db_session_factory
    with session_factory() as session:
        yield session


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_user_repository(session: Session = Depends(get_db_session)) -> UserRepository:
    return SqlAlchemyUserRepository(session)


def get_book_repository(session: Session = Depends(get_db_session)) -> BookRepository:
    return SqlAlchemyBookRepository(session)


def get_book_asset_repository(session: Session = Depends(get_db_session)) -> BookAssetRepository:
    return SqlAlchemyBookAssetRepository(session)


def get_reading_progress_repository(session: Session = Depends(get_db_session)) -> ReadingProgressRepository:
    return SqlAlchemyReadingProgressRepository(session)


def get_reading_activity_repository(session: Session = Depends(get_db_session)) -> ReadingActivityRepository:
    return SqlAlchemyReadingActivityRepository(session)


def get_reader_mark_repository(session: Session = Depends(get_db_session)) -> ReaderMarkRepository:
    return SqlAlchemyReaderMarkRepository(session)


def get_public_comment_repository(session: Session = Depends(get_db_session)) -> PublicCommentRepository:
    return SqlAlchemyPublicCommentRepository(session)


def get_invitation_repository(session: Session = Depends(get_db_session)) -> InvitationRepository:
    return SqlAlchemyInvitationRepository(session)


def get_upload_task_repository(session: Session = Depends(get_db_session)) -> UploadTaskRepository:
    return SqlAlchemyUploadTaskRepository(session)


def get_current_user(
    request: Request,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
    user_repository: UserRepository = Depends(get_user_repository),
    session: Session = Depends(get_db_session),
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")

    token = authorization.split(" ", 1)[1].strip()
    return get_user_from_bearer_token(token, request.app.state.settings, user_repository, session, request)


def get_user_from_bearer_token(token: str, settings: Settings, user_repository: UserRepository, session: Session, request: Request | None = None) -> User:
    from app.modules.auth.api_token_service import TOKEN_PREFIX, authenticate_api_token
    if token.startswith(TOKEN_PREFIX):
        user_id = authenticate_api_token(token, session, request)
        session_id = None
    else:
        user_id, session_id = decode_access_token(token, settings)
    user = user_repository.get_by_id(user_id)

    if not user or user.status != "active" or (session_id is not None and not session_is_active(session, session_id, user_id)):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid user")

    return user
