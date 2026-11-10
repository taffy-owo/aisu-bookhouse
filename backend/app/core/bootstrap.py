from app.core.config import Settings
from app.core.database import SessionFactory
from app.core.security import hash_password
from app.modules.books.factory import create_seed_books
from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.uploads.repository import SqlAlchemyUploadTaskRepository, create_seed_upload_tasks
from app.modules.users.domain import create_user
from app.modules.users.repository import SqlAlchemyUserRepository


def bootstrap_database(session_factory: SessionFactory, settings: Settings) -> None:
    with session_factory() as session:
        user_repository = SqlAlchemyUserRepository(session)
        book_repository = SqlAlchemyBookRepository(session)
        upload_task_repository = SqlAlchemyUploadTaskRepository(session)

        should_create_default_admin = settings.bootstrap_admin or settings.seed_demo_data
        if should_create_default_admin and not user_repository.get_by_email(settings.default_admin_email):
            user_repository.save(
                create_user(
                    email=settings.default_admin_email,
                    id=settings.default_user_id,
                    nickname="爱素",
                    password_hash=hash_password(settings.default_admin_password),
                    role="admin",
                )
            )

        if settings.seed_demo_data and not book_repository.list_by_owner(settings.default_user_id):
            for book in create_seed_books(settings.default_user_id):
                book_repository.save(book)

        if settings.seed_demo_data and not upload_task_repository.list_by_user(settings.default_user_id):
            for task in create_seed_upload_tasks(settings.default_user_id):
                upload_task_repository.save(task)
