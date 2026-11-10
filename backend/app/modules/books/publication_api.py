from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.dependencies import get_app_settings, get_current_user, get_db_session
from app.modules.books.publication_check import PublicationCheck, inspect_publication
from app.modules.users.domain import User

router = APIRouter(tags=['publication-verification'])


@router.get('/{book_id}/publication-check', response_model=PublicationCheck)
def check_publication(book_id: UUID, response: Response, user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session), settings: Settings = Depends(get_app_settings)):
    """Compare the original with actual online chapter bodies; never mutate publication state."""
    response.headers['Cache-Control'] = 'no-store'
    return inspect_publication(session, user.id, str(book_id), settings)
