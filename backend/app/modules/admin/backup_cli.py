from __future__ import annotations

import argparse
from contextlib import closing
from dataclasses import dataclass
import os
import signal
from pathlib import Path
import sqlite3
import tempfile

from app.core.config import Settings, get_settings
from app.core.database import create_database_engine, create_session_factory
from app.core.maintenance import ensure_no_restore_in_progress, maintenance_lock, maintenance_marker, require_writers_stopped
from app.modules.admin.backups import (
    DATABASE_ENTRY,
    STORAGE_PREFIX,
    BackupRetentionResult,
    create_backup,
    extract_backup_archive,
    get_sqlite_database_path,
    normalize_snapshot_storage_paths,
    prune_backup_files,
    read_backup_info,
    restore_storage,
    rollback_storage_restore,
    cleanup_previous_storage,
    validate_referenced_storage,
    validate_sqlite_snapshot,
)
from app.modules.admin.schemas import AdminBackupInfo
from app.modules.admin.backup_snapshot import (
    archive_backup_snapshot, capture_backup_snapshot, discard_backup_snapshot,
    new_backup_snapshot_path, prepare_backup_snapshot,
)


def run_offline_restore(*, backup_file: Path, confirmation: str, settings: Settings | None = None,
                        legacy_storage_root: Path | None = None) -> tuple[AdminBackupInfo, AdminBackupInfo]:
    if confirmation != "RESTORE":
        raise ValueError("Type RESTORE to confirm the offline restore")
    resolved_settings = settings or get_settings()
    with maintenance_lock(resolved_settings):
        return _run_offline_restore_locked(backup_file=backup_file, settings=resolved_settings, legacy_storage_root=legacy_storage_root)


def _run_offline_restore_locked(*, backup_file: Path, settings: Settings,
                               legacy_storage_root: Path | None = None) -> tuple[AdminBackupInfo, AdminBackupInfo]:
    resolved_settings = settings
    require_writers_stopped(resolved_settings)
    database_path_text = get_sqlite_database_path(resolved_settings.database_url)
    if not database_path_text:
        raise RuntimeError("Offline restore requires a file-backed SQLite database")
    backup_file = backup_file.expanduser().resolve(strict=True)
    if backup_file.stat().st_size > resolved_settings.max_backup_restore_size_bytes:
        raise ValueError("Backup exceeds the configured restore size limit")
    restored_info = read_backup_info(backup_file)

    marker = maintenance_marker(resolved_settings)
    marker.parent.mkdir(parents=True, exist_ok=True)
    if marker.exists():
        raise RuntimeError(f"A previous restore is incomplete; inspect {marker} before retrying")
    marker.write_text("Validating backup; keep application and worker stopped.\n", encoding="utf-8")
    storage_state = None
    safety_backup = None
    storage_switched = False
    completed = False
    rolled_back = False
    database_path = Path(database_path_text)
    staged_database = database_path.with_name(f".{database_path.name}.restore-new")
    previous_database = database_path.with_name(f".{database_path.name}.restore-old")
    try:
        with tempfile.TemporaryDirectory(prefix="aisu-offline-restore-") as temp_name:
            extracted = Path(temp_name) / "extracted"
            manifest = extract_backup_archive(backup_file, extracted, resolved_settings)
            snapshot = extracted / DATABASE_ENTRY
            validate_sqlite_snapshot(snapshot)
            recorded_root = manifest.get("storage_root")
            source_root = Path(recorded_root) if isinstance(recorded_root, str) and recorded_root else (
                legacy_storage_root or Path(resolved_settings.storage_root)
            )
            normalize_snapshot_storage_paths(snapshot, source_root)
            validate_referenced_storage(snapshot, extracted / STORAGE_PREFIX)
            require_writers_stopped(resolved_settings)

            engine = create_database_engine(resolved_settings)
            try:
                with create_session_factory(engine)() as session:
                    safety_backup = create_backup(session=session, settings=resolved_settings, prefix="pre-restore", forensic=True)
            finally:
                engine.dispose()
            marker.write_text(f"Safety backup: {safety_backup.filename}\nStorage not switched yet.\n", encoding="utf-8")

            if staged_database.exists() or previous_database.exists():
                raise RuntimeError("A previous database restore stage exists; inspect it before continuing")
            with closing(sqlite3.connect(f"file:{snapshot.as_posix()}?mode=ro", uri=True)) as source:
                with closing(sqlite3.connect(staged_database)) as target:
                    source.backup(target)
            validate_sqlite_snapshot(staged_database)
            storage_state = restore_storage(settings=resolved_settings, storage_snapshot=extracted / STORAGE_PREFIX)
            storage_switched = True
            marker.write_text(f"Safety backup: {safety_backup.filename}\nStorage switched; database pending.\n", encoding="utf-8")
            try:
                require_writers_stopped(resolved_settings)
                with closing(sqlite3.connect(database_path)) as current:
                    current.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                for suffix in ("-wal", "-shm"):
                    Path(f"{database_path}{suffix}").unlink(missing_ok=True)
                os.replace(database_path, previous_database)
                os.replace(staged_database, database_path)
                validate_sqlite_snapshot(database_path)
                restore_runtime_ownership(resolved_settings, database_path)
            except Exception:
                if previous_database.exists():
                    os.replace(previous_database, database_path)
                rollback_storage_restore(storage_state)
                storage_state = None
                storage_switched = False
                rolled_back = True
                raise
            previous_database.unlink(missing_ok=True)
            cleanup_previous_storage(storage_state)
            storage_state = None
            completed = True
            return restored_info, safety_backup
    finally:
        if not storage_switched and not previous_database.exists():
            staged_database.unlink(missing_ok=True)
        if completed or rolled_back or (not storage_switched and not previous_database.exists()):
            marker.unlink(missing_ok=True)


@dataclass(frozen=True)
class ScheduledBackupResult:
    backup: AdminBackupInfo
    retention: BackupRetentionResult


def run_scheduled_backup(
    *,
    settings: Settings | None = None,
    prefix: str = "scheduled",
    keep_count: int = 2,
    keep_days: int | None = None,
) -> ScheduledBackupResult:
    resolved_settings = settings or get_settings()
    with maintenance_lock(resolved_settings):
        ensure_no_restore_in_progress(resolved_settings)
        return _run_scheduled_backup_locked(settings=resolved_settings, prefix=prefix, keep_count=keep_count, keep_days=keep_days)


def _run_scheduled_backup_locked(*, settings: Settings, prefix: str, keep_count: int, keep_days: int | None) -> ScheduledBackupResult:
    resolved_settings = settings
    require_writers_stopped(resolved_settings)
    engine = create_database_engine(resolved_settings)
    session_factory = create_session_factory(engine)

    try:
        with session_factory() as session:
            backup = create_backup(session=session, settings=resolved_settings, prefix=prefix)
        retention = prune_backup_files(
            resolved_settings,
            prefix=prefix,
            keep_count=keep_count,
            keep_days=keep_days,
        )
    finally:
        engine.dispose()

    return ScheduledBackupResult(backup=backup, retention=retention)


def restore_runtime_ownership(settings: Settings, database_path: Path) -> None:
    if settings.environment != "production":
        return
    import pwd

    service_user = pwd.getpwnam("aisu-bookhouse")
    # Read-only validation of a WAL-mode database may create sidecar files as
    # root. The service user must be able to write them after the switch too.
    sidecars = tuple(Path(f"{database_path}{suffix}") for suffix in ("-wal", "-shm") if Path(f"{database_path}{suffix}").exists())
    roots = (database_path, *sidecars, Path(settings.storage_root).expanduser().resolve())
    for root in roots:
        if not root.exists():
            raise RuntimeError(f"Restored runtime path is missing: {root}")
        paths = (root, *root.rglob("*")) if root.is_dir() else (root,)
        for path in paths:
            os.chown(path, service_user.pw_uid, service_user.pw_gid)


def run_backup_retention(
    *, settings: Settings | None = None, prefix: str, keep_count: int,
    protected_filenames: list[str] | tuple[str, ...] = (),
) -> BackupRetentionResult:
    resolved_settings = settings or get_settings()
    with maintenance_lock(resolved_settings):
        ensure_no_restore_in_progress(resolved_settings)
        # Closed archives can be pruned while writers serve the live database.
        return prune_backup_files(resolved_settings, prefix=prefix, keep_count=keep_count,
                                  protected_filenames=protected_filenames)


def main() -> None:
    parser = argparse.ArgumentParser(description="Create, restore, or prune Aisu Bookhouse backups.")
    subparsers = parser.add_subparsers(dest="command")
    create_parser = subparsers.add_parser("create", help="Create a scheduled backup.")
    create_parser.add_argument("--prefix", default="scheduled", help="Filename prefix for automatic backups.")
    create_parser.add_argument("--keep-count", default=2, type=int, help="Number of automatic backups to keep.")
    create_parser.add_argument("--keep-days", default=None, type=int, help="Maximum age in days for automatic backups.")
    subparsers.add_parser("snapshot-path", help="Choose a private snapshot path without creating files.")
    prepare_parser = subparsers.add_parser("prepare", help="Precopy storage while writers remain online.")
    prepare_parser.add_argument("--prefix", default="scheduled")
    prepare_parser.add_argument("--directory", type=Path)
    capture_parser = subparsers.add_parser("capture", help="Seal a snapshot while writers are stopped.")
    capture_parser.add_argument("--directory", required=True, type=Path)
    archive_parser = subparsers.add_parser("archive", help="Archive a sealed snapshot while writers are online.")
    archive_parser.add_argument("--directory", required=True, type=Path)
    archive_parser.add_argument("--keep-count", default=2, type=int)
    discard_parser = subparsers.add_parser("discard-snapshot", help="Remove a private temporary snapshot.")
    discard_parser.add_argument("--directory", required=True, type=Path)
    restore_parser = subparsers.add_parser("restore", help="Restore while the app and worker are stopped.")
    restore_parser.add_argument("--file", required=True, type=Path)
    restore_parser.add_argument("--confirm", required=True)
    restore_parser.add_argument("--legacy-storage-root", type=Path,
                                help="Original storage root for old backups with absolute paths when restoring to a different directory")
    prune_parser = subparsers.add_parser("prune", help="Prune closed archives without stopping live writers.")
    prune_parser.add_argument("--prefix", required=True)
    prune_parser.add_argument("--keep-count", required=True, type=int)
    prune_parser.add_argument("--protect-filename", action="append", default=[])
    args = parser.parse_args()

    if args.command in {"prepare", "capture", "archive", "discard-snapshot"}:
        def interrupted(_number, _frame):
            # Let snapshot/ZIP finally blocks remove partial files on a
            # systemd stop, instead of leaving a library-sized orphan.
            raise SystemExit(143)
        signal.signal(signal.SIGTERM, interrupted)

    if args.command == "snapshot-path":
        print(new_backup_snapshot_path(get_settings()))
        return
    if args.command == "prepare":
        print(prepare_backup_snapshot(settings=get_settings(), prefix=args.prefix, directory=args.directory))
        return
    if args.command == "capture":
        result = capture_backup_snapshot(settings=get_settings(), directory=args.directory)
        print("snapshot_captured=" + ",".join(f"{key}:{value}" for key, value in result.items()))
        return
    if args.command == "discard-snapshot":
        with maintenance_lock(get_settings()):
            discard_backup_snapshot(settings=get_settings(), directory=args.directory)
        return
    if args.command == "archive":
        settings = get_settings()
        backup = archive_backup_snapshot(settings=settings, directory=args.directory)
        retention = run_backup_retention(settings=settings, prefix=backup.filename.rsplit("-", 3)[0], keep_count=args.keep_count)
        print(f"created={backup.filename}")
        print(f"deleted={len(retention.deleted)}")
        for filename in retention.deleted:
            print(f"deleted_file={filename}")
        return
    if args.command == "prune":
        retention = run_backup_retention(prefix=args.prefix, keep_count=args.keep_count,
                                        protected_filenames=args.protect_filename)
        print(f"deleted={len(retention.deleted)}")
        for filename in retention.deleted:
            print(f"deleted_file={filename}")
        return
    if args.command == "restore":
        restored, safety = run_offline_restore(backup_file=args.file, confirmation=args.confirm, legacy_storage_root=args.legacy_storage_root)
        print(f"restored={restored.filename}")
        print(f"safety_backup={safety.filename}")
        return
    if args.command != "create":
        parser.print_help()
        raise SystemExit(2)

    result = run_scheduled_backup(prefix=args.prefix, keep_count=args.keep_count, keep_days=args.keep_days)
    print(f"created={result.backup.filename}")
    print(f"deleted={len(result.retention.deleted)}")
    for filename in result.retention.deleted:
        print(f"deleted_file={filename}")


if __name__ == "__main__":
    main()
