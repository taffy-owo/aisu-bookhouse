from fastapi import APIRouter

from app.api.v1 import health
from app.modules.agent.api import router as agent_router
from app.modules.admin.api import router as admin_router
from app.modules.ai_channels.api import router as ai_channels_router
from app.modules.auth.api import router as auth_router
from app.modules.auth.api_tokens import router as api_tokens_router
from app.modules.books.api import router as books_router
from app.modules.books.continuation_api import router as continuation_router
from app.modules.books.publication_api import router as publication_router
from app.modules.comments.api import router as comments_router
from app.modules.files.api import router as files_router
from app.modules.invitations.api import router as invitations_router
from app.modules.reader.api import router as reader_router
from app.modules.reader_marks.api import router as reader_marks_router
from app.modules.reading_activity.api import router as reading_activity_router
from app.modules.reading_progress.api import router as progress_router
from app.modules.uploads.api import router as uploads_router
from app.modules.translations.api import router as translations_router

api_router = APIRouter()
api_router.include_router(agent_router, prefix="/agent")
api_router.include_router(health.router)
api_router.include_router(admin_router, prefix="/admin")
api_router.include_router(ai_channels_router, prefix="/ai-channels")
api_router.include_router(auth_router, prefix="/auth")
api_router.include_router(api_tokens_router, prefix="/auth")
api_router.include_router(books_router, prefix="/books")
api_router.include_router(continuation_router, prefix="/books")
api_router.include_router(publication_router, prefix="/books")
api_router.include_router(files_router, prefix="/files")
api_router.include_router(invitations_router, prefix="/invitations")
api_router.include_router(reader_router, prefix="/books")
api_router.include_router(reader_marks_router, prefix="/books")
api_router.include_router(comments_router, prefix="/books")
api_router.include_router(progress_router, prefix="/books")
api_router.include_router(reading_activity_router)
api_router.include_router(uploads_router, prefix="/uploads")
api_router.include_router(translations_router, prefix="/translations")
