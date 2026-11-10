from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import Engine, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.storage import get_storage_root, resolve_storage_path
from app.modules.admin.schemas import AdminSystemIssue, AdminSystemReport, AdminSystemTableStat


CORE_TABLES = [
    "users",
    "books",
    "book_assets",
    "public_comments",
    "upload_tasks",
    "reader_marks",
    "reading_activity",
    "reading_activity_events",
    "reading_progress",
    "invitations",
]

STALE_PROCESSING_TASK_AGE = timedelta(hours=2)


def build_system_report(*, engine: Engine, session: Session, settings: Settings) -> AdminSystemReport:
    table_names = set(inspect(engine).get_table_names())
    database_path = get_sqlite_database_path(settings.database_url) if engine.dialect.name == "sqlite" else None
    storage_root = get_storage_root(settings)

    return AdminSystemReport(
        database_engine=engine.dialect.name,
        database_path=str(database_path) if database_path else None,
        database_size_bytes=get_database_size(database_path),
        database_auxiliary_size_bytes=get_sqlite_auxiliary_size(database_path),
        storage_root=str(storage_root),
        storage_size_bytes=get_directory_size(storage_root),
        sqlite_journal_mode=get_sqlite_pragma(session, "journal_mode") if engine.dialect.name == "sqlite" else None,
        sqlite_foreign_keys=get_sqlite_foreign_keys(session) if engine.dialect.name == "sqlite" else None,
        sqlite_quick_check=get_sqlite_quick_check(session) if engine.dialect.name == "sqlite" else None,
        table_stats=get_table_stats(session, table_names),
        issues=get_health_issues(session, table_names, storage_root),
        checked_at=datetime.now(timezone.utc),
    )


def get_table_stats(session: Session, table_names: set[str]) -> list[AdminSystemTableStat]:
    stats: list[AdminSystemTableStat] = []
    for table_name in CORE_TABLES:
        if table_name not in table_names:
            continue
        count = session.execute(text(f"SELECT COUNT(*) FROM {table_name}")).scalar_one()
        stats.append(AdminSystemTableStat(name=table_name, rows=int(count)))
    return stats


def get_health_issues(session: Session, table_names: set[str], storage_root: Path) -> list[AdminSystemIssue]:
    issues: list[AdminSystemIssue] = []
    if "books" in table_names:
        missing_originals = count_missing_storage_paths(
            session,
            storage_root,
            "SELECT original_file_path FROM books WHERE status != 'deleted' AND original_file_path IS NOT NULL",
        )
        if missing_originals:
            issues.append(
                AdminSystemIssue(
                    code="missing_original_files",
                    severity="danger",
                    title="原文件缺失",
                    detail="有书籍记录指向的原始文件已经不存在，下载和重新解析会失败。",
                    count=missing_originals,
                )
            )

    if "book_assets" in table_names:
        missing_assets = count_missing_storage_paths(session, storage_root, "SELECT path FROM book_assets")
        if missing_assets:
            issues.append(
                AdminSystemIssue(
                    code="missing_asset_files",
                    severity="warning",
                    title="派生资源缺失",
                    detail="部分封面、漫画页或章节图片文件不存在，阅读页可能会缺图。",
                    count=missing_assets,
                )
            )

    if {"book_assets", "books"}.issubset(table_names):
        orphan_assets = session.execute(
            text("SELECT COUNT(*) FROM book_assets LEFT JOIN books ON book_assets.book_id = books.id WHERE books.id IS NULL")
        ).scalar_one()
        if orphan_assets:
            issues.append(
                AdminSystemIssue(
                    code="orphan_book_assets",
                    severity="warning",
                    title="孤儿资源记录",
                    detail="有资源记录找不到对应书籍，可能来自历史删除或异常中断。",
                    count=int(orphan_assets),
                )
            )

        deleted_book_assets = session.execute(
            text("SELECT COUNT(*) FROM book_assets JOIN books ON book_assets.book_id = books.id WHERE books.status = 'deleted'")
        ).scalar_one()
        if deleted_book_assets:
            issues.append(
                AdminSystemIssue(
                    code="deleted_book_assets",
                    severity="warning",
                    title="已删除书籍残留资源",
                    detail="部分已删除书籍仍有资源索引残留，可能来自历史异常中断或手动改库。",
                    count=int(deleted_book_assets),
                )
            )

    if {"upload_tasks", "books"}.issubset(table_names):
        unavailable_processing_tasks = session.execute(
            text(
                "SELECT COUNT(*) FROM upload_tasks "
                "LEFT JOIN books ON upload_tasks.book_id = books.id "
                "WHERE upload_tasks.status = 'processing' "
                "AND (upload_tasks.book_id IS NULL OR books.id IS NULL OR books.status = 'deleted')"
            )
        ).scalar_one()
        if unavailable_processing_tasks:
            issues.append(
                AdminSystemIssue(
                    code="unavailable_processing_upload_tasks",
                    severity="danger",
                    title="解析任务无法继续",
                    detail="有上传解析任务指向不存在或已删除的书籍，后台 worker 会将其收口为失败状态。",
                    count=int(unavailable_processing_tasks),
                )
            )

    if "upload_tasks" in table_names:
        stale_cutoff = datetime.now(timezone.utc) - STALE_PROCESSING_TASK_AGE
        stale_processing_tasks = session.execute(
            text("SELECT COUNT(*) FROM upload_tasks WHERE status = 'processing' AND updated_at < :cutoff"),
            {"cutoff": stale_cutoff},
        ).scalar_one()
        if stale_processing_tasks:
            issues.append(
                AdminSystemIssue(
                    code="stale_processing_upload_tasks",
                    severity="warning",
                    title="解析任务长时间未更新",
                    detail="有上传任务已经超过 2 小时没有更新，建议检查上传 worker 日志或重新解析。",
                    count=int(stale_processing_tasks),
                )
            )

    if not issues:
        issues.append(AdminSystemIssue(code="ok", severity="info", title="数据健康", detail="未发现明显的数据库和文件索引不一致。", count=0))
    return issues


def count_missing_storage_paths(session: Session, storage_root: Path, query: str) -> int:
    count = 0
    for row in session.execute(text(query)).all():
        relative_path = row[0]
        if not relative_path:
            continue
        try:
            path = resolve_storage_path(storage_root, relative_path)
        except ValueError:
            count += 1
            continue
        if not path.is_file():
            count += 1
    return count


def get_sqlite_database_path(database_url: str) -> Path | None:
    database = make_url(database_url).database
    if not database or database == ":memory:":
        return None
    return Path(database).expanduser().resolve()


def get_database_size(database_path: Path | None) -> int:
    return database_path.stat().st_size if database_path and database_path.is_file() else 0


def get_sqlite_auxiliary_size(database_path: Path | None) -> int:
    if not database_path:
        return 0
    return sum(path.stat().st_size for path in [database_path.with_name(f"{database_path.name}-wal"), database_path.with_name(f"{database_path.name}-shm")] if path.is_file())


def get_directory_size(root: Path) -> int:
    if not root.exists():
        return 0
    return sum(path.stat().st_size for path in root.rglob("*") if path.is_file())


def get_sqlite_pragma(session: Session, name: str) -> str | None:
    value = session.execute(text(f"PRAGMA {name}")).scalar()
    return str(value) if value is not None else None


def get_sqlite_foreign_keys(session: Session) -> bool:
    return get_sqlite_pragma(session, "foreign_keys") == "1"


def get_sqlite_quick_check(session: Session) -> str:
    return str(session.execute(text("PRAGMA quick_check")).scalar_one())
