from pathlib import Path
import tempfile
from uuid import uuid4

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.engine import make_url
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import Settings


class Base(DeclarativeBase):
    pass


SessionFactory = sessionmaker[Session]


def create_database_engine(settings: Settings) -> Engine:
    database_url = normalize_sqlite_memory_url(settings.database_url)
    engine_options: dict[str, object] = {"future": True}
    connect_args: dict[str, object] = {}

    if database_url.startswith("sqlite"):
        connect_args["check_same_thread"] = False
        connect_args["timeout"] = 30
        ensure_sqlite_parent_exists(database_url)

    engine = create_engine(database_url, connect_args=connect_args, **engine_options)
    if database_url.startswith("sqlite"):
        configure_sqlite_connection(engine)
    return engine


def normalize_sqlite_memory_url(database_url: str) -> str:
    if not database_url.startswith("sqlite"):
        return database_url
    if make_url(database_url).database != ":memory:":
        return database_url
    path = Path(tempfile.gettempdir()) / f"aisu-bookhouse-test-{uuid4().hex}.db"
    return f"sqlite+pysqlite:///{path.as_posix()}"


def configure_sqlite_connection(engine: Engine) -> None:
    @event.listens_for(engine, "connect")
    def apply_sqlite_pragmas(dbapi_connection: object, _connection_record: object) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()


def create_session_factory(engine: Engine) -> SessionFactory:
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def create_database_schema(engine: Engine) -> None:
    import_model_modules()
    Base.metadata.create_all(bind=engine)
    sync_sqlite_schema(engine)


def sync_sqlite_schema(engine: Engine) -> None:
    if engine.dialect.name != "sqlite":
        return

    with engine.begin() as connection:
        import_model_modules()
        book_columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(books)").all()}
        missing_book_columns = {
            "language": "VARCHAR(16) NOT NULL DEFAULT 'und'",
            "series_title": "VARCHAR(255)",
            "series_order": "FLOAT",
            "series_kind": "VARCHAR(80)",
            "publication_status": "VARCHAR(32) NOT NULL DEFAULT 'completed'",
            "source_url": "VARCHAR(1000)",
            "source_episode_count": "INTEGER",
            "source_character_count": "INTEGER",
            "source_update_count": "INTEGER NOT NULL DEFAULT 0",
            "source_pending_episode_indexes": "JSON NOT NULL DEFAULT '[]'",
            "source_checked_at": "DATETIME",
            "source_check_error": "VARCHAR(500)",
            "source_schedule_time": "VARCHAR(5)",
            "source_schedule_timezone": "VARCHAR(64)",
            "source_schedule_label": "VARCHAR(120)",
            "auto_translate_updates": "BOOLEAN NOT NULL DEFAULT 1",
            "public_status": "VARCHAR(32) NOT NULL DEFAULT 'private'",
            "public_requested_at": "DATETIME",
            "public_approved_at": "DATETIME",
            "public_rejected_at": "DATETIME",
            "public_moderated_by": "VARCHAR(36)",
            "public_share_note": "TEXT",
            "public_source_note": "TEXT",
            "public_download_allowed": "BOOLEAN NOT NULL DEFAULT 1",
        }.items()
        for column_name, column_type in missing_book_columns:
            if column_name not in book_columns:
                connection.exec_driver_sql(f"ALTER TABLE books ADD COLUMN {column_name} {column_type}")

        translation_tables = {row[0] for row in connection.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'").all()}
        if "ai_channel_models" in translation_tables:
            model_columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(ai_channel_models)").all()}
            if "availability_revision" not in model_columns:
                connection.exec_driver_sql("ALTER TABLE ai_channel_models ADD COLUMN availability_revision INTEGER NOT NULL DEFAULT 0")
        if "whole_book_translation_jobs" in translation_tables:
            job_columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(whole_book_translation_jobs)").all()}
            if "job_kind" not in job_columns:
                connection.exec_driver_sql("ALTER TABLE whole_book_translation_jobs ADD COLUMN job_kind VARCHAR(32) NOT NULL DEFAULT 'whole_book'")
            from app.modules.translations.idempotency import install_unique_indexes
            install_unique_indexes(connection)


def ensure_sqlite_parent_exists(database_url: str) -> None:
    database_path = make_url(database_url).database
    if not database_path or database_path == ":memory:" or database_path.startswith("file:"):
        return

    Path(database_path).expanduser().parent.mkdir(parents=True, exist_ok=True)


def import_model_modules() -> None:
    import app.modules.agent.models  # noqa: F401
    import app.modules.auth.models  # noqa: F401
    import app.modules.ai_channels.models  # noqa: F401
    import app.modules.book_assets.models  # noqa: F401
    import app.modules.books.models  # noqa: F401
    import app.modules.comments.models  # noqa: F401
    import app.modules.invitations.models  # noqa: F401
    import app.modules.reader_marks.models  # noqa: F401
    import app.modules.reading_activity.models  # noqa: F401
    import app.modules.reading_progress.models  # noqa: F401
    import app.modules.uploads.models  # noqa: F401
    import app.modules.translations.models  # noqa: F401
    import app.modules.users.models  # noqa: F401
