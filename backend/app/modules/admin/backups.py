from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Collection
from contextlib import closing
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import tempfile
from typing import BinaryIO
import uuid
from zipfile import ZIP_DEFLATED, ZIP_STORED, BadZipFile, ZipFile, ZipInfo
import zlib

from fastapi import HTTPException, status
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.storage import CHUNK_SIZE, get_storage_root, resolve_storage_path
from app.modules.admin.schemas import AdminBackupInfo

BACKUP_FORMAT_VERSION = 1
BACKUP_EXTENSION = ".zip"
DATABASE_ENTRY = "database.sqlite3"
MANIFEST_ENTRY = "manifest.json"
STORAGE_PREFIX = "storage"
COMPRESSION_SAMPLE_BYTES = 64 * 1024
COMPRESSION_MIN_FILE_BYTES = 1024 * 1024


@dataclass(frozen=True)
class StorageRestoreState:
    storage_root: Path
    previous_storage: Path


@dataclass(frozen=True)
class BackupRetentionResult:
    kept: list[AdminBackupInfo]
    deleted: list[str]


def get_backup_root(settings: Settings) -> Path:
    storage_root = get_storage_root(settings)
    backup_root = storage_root.parent / "backups"
    backup_root.mkdir(parents=True, exist_ok=True)
    return backup_root.resolve()


def list_backup_files(settings: Settings) -> list[AdminBackupInfo]:
    backup_root = get_backup_root(settings)
    backups = [read_backup_info(path) for path in backup_root.glob(f"*{BACKUP_EXTENSION}") if path.is_file()]
    return sorted(backups, key=lambda backup: backup.created_at, reverse=True)


def prune_backup_files(
    settings: Settings,
    *,
    prefix: str | None = None,
    keep_count: int | None = None,
    keep_days: int | None = None,
    protected_filenames: Collection[str] = (),
    now: datetime | None = None,
) -> BackupRetentionResult:
    if keep_count is not None and keep_count < 0:
        raise ValueError("keep_count cannot be negative")
    if keep_days is not None and keep_days < 0:
        raise ValueError("keep_days cannot be negative")

    backup_root = get_backup_root(settings)
    protected = set(protected_filenames)
    for filename in protected:
        if Path(filename).name != filename or '/' in filename or '\\' in filename or not filename.endswith(BACKUP_EXTENSION):
            raise ValueError("Protected backup must be a plain ZIP filename")
        path = backup_root / filename
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Protected backup is missing or is not a regular file: {filename}")
    candidates: list[tuple[Path, AdminBackupInfo]] = []
    for path in backup_root.glob(f"*{BACKUP_EXTENSION}"):
        if path.is_symlink():
            raise ValueError(f"Backup retention refuses symbolic links: {path.name}")
        if not path.is_file():
            continue
        if prefix is not None and not path.name.startswith(f"{prefix}-"):
            continue
        candidates.append((path, read_backup_info(path)))

    candidates.sort(key=lambda item: item[1].created_at, reverse=True)
    cutoff = None
    if keep_days is not None:
        cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=keep_days)

    kept: list[AdminBackupInfo] = []
    deleted: list[str] = []
    index = 0
    for path, backup in candidates:
        if path.name in protected:
            kept.append(backup)
            continue
        should_delete_for_count = keep_count is not None and index >= keep_count
        should_delete_for_age = cutoff is not None and backup.created_at < cutoff
        index += 1
        if should_delete_for_count or should_delete_for_age:
            path.unlink(missing_ok=True)
            deleted.append(path.name)
        else:
            kept.append(backup)

    return BackupRetentionResult(kept=kept, deleted=deleted)


def create_backup(*, session: Session, settings: Settings, prefix: str = "aisu-bookhouse", forensic: bool = False) -> AdminBackupInfo:
    backup_root = get_backup_root(settings)
    backup_id = f"{prefix}-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    destination = (backup_root / f"{backup_id}{BACKUP_EXTENSION}").resolve()
    temporary_destination = (backup_root / f".{backup_id}{BACKUP_EXTENSION}.tmp").resolve()
    ensure_path_inside(backup_root, destination)
    ensure_path_inside(backup_root, temporary_destination)

    with tempfile.TemporaryDirectory(prefix="aisu-backup-") as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        database_snapshot = temp_dir / DATABASE_ENTRY
        backup_sqlite_database(session, database_snapshot)
        if not forensic:
            normalize_snapshot_storage_paths(database_snapshot, get_storage_root(settings))
        referenced_asset_count, missing_references = inspect_referenced_storage(database_snapshot, get_storage_root(settings))
        if missing_references and not forensic:
            raise RuntimeError(f"Database references missing storage files; backup aborted: {missing_references[:5]}")

        manifest = build_manifest(session=session, settings=settings, backup_id=backup_id)
        manifest["referenced_asset_count"] = referenced_asset_count
        manifest["restorable"] = not missing_references
        manifest["missing_storage_references"] = missing_references
        try:
            with ZipFile(temporary_destination, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
                archive.write(database_snapshot, DATABASE_ENTRY)
                manifest["database_sha256"] = hash_file(database_snapshot)
                manifest["storage_files"] = add_storage_files(archive, get_storage_root(settings))
                manifest["storage_file_count"] = len(manifest["storage_files"])
                archive.writestr(MANIFEST_ENTRY, json.dumps(manifest, ensure_ascii=False, indent=2))
            temporary_destination.replace(destination)
        except Exception:
            temporary_destination.unlink(missing_ok=True)
            raise

    return read_backup_info(destination)


def get_backup_file_path(settings: Settings, filename: str) -> Path:
    if Path(filename).name != filename or not filename.endswith(BACKUP_EXTENSION):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Backup not found")

    backup_root = get_backup_root(settings)
    backup_path = (backup_root / filename).resolve()
    ensure_path_inside(backup_root, backup_path)
    if not backup_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Backup not found")
    return backup_path


def backup_sqlite_database(session: Session, destination: Path) -> None:
    bind = session.get_bind()
    if bind.dialect.name != "sqlite":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backups currently support SQLite only")

    session.flush()
    raw_connection = get_raw_sqlite_connection(session)
    destination.parent.mkdir(parents=True, exist_ok=True)
    target_connection = sqlite3.connect(destination)
    try:
        raw_connection.backup(target_connection)
    finally:
        target_connection.close()


def validate_sqlite_snapshot(database_snapshot: Path) -> None:
    try:
        connection = sqlite3.connect(f"file:{database_snapshot.as_posix()}?mode=ro", uri=True)
        try:
            result = connection.execute("PRAGMA quick_check").fetchone()
        finally:
            connection.close()
    except sqlite3.DatabaseError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup database snapshot is invalid") from exc

    if not result or result[0] != "ok":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup database snapshot failed integrity check")


def validate_referenced_storage(database_snapshot: Path, storage_root: Path) -> int:
    referenced_count, missing = inspect_referenced_storage(database_snapshot, storage_root)
    if missing:
        raise RuntimeError(f"Database references missing storage files; backup aborted: {missing[:5]}")
    return referenced_count


def normalize_snapshot_storage_paths(database_snapshot: Path, source_storage_root: Path) -> int:
    """Rebase legacy absolute paths in a private snapshot, never in the live DB.

    Resolving a reference is only a containment check. File validation must use
    the extracted archive after rebasing, so live files cannot mask missing data.
    """
    root = source_storage_root.expanduser().resolve()

    def relative(value: str) -> str:
        path = Path(value)
        if not path.is_absolute():
            return value
        try:
            return path.resolve().relative_to(root).as_posix()
        except ValueError as error:
            raise RuntimeError("Backup database references a file outside its storage root") from error

    changed = 0
    with closing(sqlite3.connect(database_snapshot)) as connection, connection:
        for book_id, value in connection.execute(
            "SELECT id, original_file_path FROM books WHERE status!='deleted' AND original_file_path IS NOT NULL"
        ).fetchall():
            normalized = relative(value)
            if normalized != value:
                connection.execute("UPDATE books SET original_file_path=? WHERE id=?", (normalized, book_id))
                changed += 1
        for asset_id, value, metadata in connection.execute(
            'SELECT a.id, a.path, a.metadata FROM book_assets a JOIN books b ON b.id=a.book_id WHERE b.status!=\'deleted\''
        ).fetchall():
            normalized = relative(value)
            if normalized != value:
                connection.execute("UPDATE book_assets SET path=? WHERE id=?", (normalized, asset_id))
                changed += 1
            details = json.loads(metadata) if metadata else {}
            blocks_path = details.get("blocks_path") if isinstance(details, dict) else None
            if isinstance(blocks_path, str):
                normalized_blocks = relative(blocks_path)
                if normalized_blocks != blocks_path:
                    details["blocks_path"] = normalized_blocks
                    connection.execute("UPDATE book_assets SET metadata=? WHERE id=?", (json.dumps(details, ensure_ascii=False), asset_id))
                    changed += 1
    return changed


def inspect_referenced_storage(database_snapshot: Path, storage_root: Path) -> tuple[int, list[str]]:
    with closing(sqlite3.connect(f"file:{database_snapshot.as_posix()}?mode=ro", uri=True)) as connection:
        references = connection.execute(
            "SELECT a.path FROM book_assets a JOIN books b ON b.id=a.book_id WHERE b.status!='deleted' "
            "UNION ALL SELECT original_file_path FROM books WHERE original_file_path IS NOT NULL AND status!='deleted'"
        ).fetchall()
    missing: list[str] = []
    for (relative_path,) in references:
        try:
            if not resolve_storage_path(storage_root, relative_path).is_file():
                missing.append(relative_path)
        except (ValueError, HTTPException):
            missing.append(relative_path)
    return len(references), sorted(set(missing))


def get_raw_sqlite_connection(session: Session) -> sqlite3.Connection:
    connection = session.connection().connection
    raw_connection = getattr(connection, "driver_connection", connection)
    if not isinstance(raw_connection, sqlite3.Connection):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="SQLite connection is unavailable")
    return raw_connection


def build_manifest(*, session: Session, settings: Settings, backup_id: str) -> dict[str, object]:
    storage_root = get_storage_root(settings)
    migration = None
    if session.get_bind().dialect.name == "sqlite":
        has_migrations = session.connection().exec_driver_sql("SELECT 1 FROM sqlite_master WHERE type='table' AND name='alembic_version'").scalar()
        if has_migrations:
            migration = session.connection().exec_driver_sql("SELECT version_num FROM alembic_version LIMIT 1").scalar()
    return {
        "backup_id": backup_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "database_engine": session.get_bind().dialect.name,
        "database_path": get_sqlite_database_path(settings.database_url),
        "format_version": BACKUP_FORMAT_VERSION,
        "migration_version": migration,
        "application_release": Path(__file__).resolve().parents[4].name,
        "product": "aisu-bookhouse",
        "storage_size_bytes": get_directory_size(storage_root),
        "storage_root": str(storage_root),
    }


def add_storage_files(archive: ZipFile, storage_root: Path, *, expected_checksums: dict[str, str] | None = None) -> dict[str, str]:
    checksums: dict[str, str] = {}
    if not storage_root.exists():
        if expected_checksums:
            raise RuntimeError("Backup snapshot file inventory changed")
        return checksums

    for path in sorted(storage_root.rglob("*")):
        if path.is_symlink():
            raise RuntimeError(f"Storage contains a symbolic link: {path.relative_to(storage_root).as_posix()}")
        if not path.is_file():
            continue
        relative_path = path.relative_to(storage_root).as_posix()
        info = ZipInfo.from_file(path, f"{STORAGE_PREFIX}/{relative_path}")
        expected_size = info.file_size
        digest = hashlib.sha256()
        bytes_written = 0
        with path.open("rb") as source:
            info.compress_type = select_storage_compression(source, expected_size)
            with archive.open(info, "w", force_zip64=expected_size >= 2 * 1024**3) as target:
                for chunk in iter(lambda: source.read(CHUNK_SIZE), b""):
                    target.write(chunk)
                    digest.update(chunk)
                    bytes_written += len(chunk)
        if bytes_written != expected_size:
            raise RuntimeError(f"Storage file changed during backup: {relative_path}")
        checksums[relative_path] = digest.hexdigest()
        expected = expected_checksums.get(relative_path) if expected_checksums is not None else hash_file(path)
        if checksums[relative_path] != expected:
            raise RuntimeError(f"Storage file changed during backup: {relative_path}")
    if expected_checksums is not None and checksums.keys() != expected_checksums.keys():
        raise RuntimeError("Backup snapshot file inventory changed")
    return checksums


def select_storage_compression(source: BinaryIO, file_size: int) -> int:
    if file_size < COMPRESSION_MIN_FILE_BYTES:
        return ZIP_DEFLATED

    # Sample the body rather than PDF headers or archive directory metadata.
    # This only chooses compression; every archived byte is still hashed.
    sample_bytes = compressed_bytes = 0
    try:
        for part in range(1, 5):
            source.seek(min(file_size * part // 5, file_size - COMPRESSION_SAMPLE_BYTES))
            sample = source.read(COMPRESSION_SAMPLE_BYTES)
            sample_bytes += len(sample)
            compressed_bytes += len(zlib.compress(sample, level=1))
    finally:
        source.seek(0)
    if sample_bytes and compressed_bytes >= sample_bytes * 0.98:
        return ZIP_STORED
    return ZIP_DEFLATED


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def extract_backup_archive(backup_path: Path, destination: Path, settings: Settings) -> dict[str, object]:
    destination.mkdir(parents=True, exist_ok=True)
    try:
        with ZipFile(backup_path) as archive:
            validate_backup_archive(archive, settings)
            archive.extractall(destination)
    except BadZipFile as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup file is not a valid zip archive") from exc

    manifest_path = destination / MANIFEST_ENTRY
    if not manifest_path.is_file():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup manifest is missing")

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup manifest is invalid") from exc

    if int(manifest.get("format_version") or 0) != BACKUP_FORMAT_VERSION:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported backup format version")
    if manifest.get("restorable") is False:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot restore an incomplete safety backup")
    if isinstance(manifest.get("database_sha256"), str) and hash_file(destination / DATABASE_ENTRY) != manifest["database_sha256"]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup database checksum mismatch")
    checksums = manifest.get("storage_files")
    if isinstance(checksums, dict):
        for name, expected in checksums.items():
            if not isinstance(name, str) or not isinstance(expected, str):
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup storage manifest is invalid")
            validate_zip_member_name(f"{STORAGE_PREFIX}/{name}")
            if not (destination / STORAGE_PREFIX / name).is_file():
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup storage manifest is invalid")
            if hash_file(destination / STORAGE_PREFIX / name) != expected:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup storage checksum mismatch")
    return manifest


def validate_backup_archive(archive: ZipFile, settings: Settings) -> None:
    names = set(archive.namelist())
    if MANIFEST_ENTRY not in names or DATABASE_ENTRY not in names:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup archive is missing required files")

    extracted_size = 0
    for info in archive.infolist():
        validate_zip_member_name(info.filename)
        extracted_size += info.file_size
        if extracted_size > settings.max_backup_restore_extracted_size_bytes:
            raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail="Backup archive exceeds configured extracted size limit")


def validate_zip_member_name(filename: str) -> None:
    if "\\" in filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup archive contains an unsafe path")

    path = PurePosixPath(filename)
    if path.is_absolute() or ".." in path.parts or any(part == "" for part in path.parts):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup archive contains an unsafe path")


def restore_storage(*, settings: Settings, storage_snapshot: Path) -> StorageRestoreState:
    storage_root = get_storage_root(settings)
    parent = storage_root.parent
    restore_id = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    staged_storage = parent / f"{storage_root.name}.restore-new-{restore_id}-{uuid.uuid4().hex[:8]}"
    previous_storage = parent / f"{storage_root.name}.restore-old-{restore_id}-{uuid.uuid4().hex[:8]}"

    if storage_snapshot.exists():
        shutil.copytree(storage_snapshot, staged_storage)
    else:
        staged_storage.mkdir(parents=True, exist_ok=True)

    if storage_root.exists():
        shutil.move(str(storage_root), str(previous_storage))

    try:
        shutil.move(str(staged_storage), str(storage_root))
    except Exception:
        if not storage_root.exists() and previous_storage.exists():
            shutil.move(str(previous_storage), str(storage_root))
        if staged_storage.exists():
            shutil.rmtree(staged_storage, ignore_errors=True)
        raise

    return StorageRestoreState(storage_root=storage_root, previous_storage=previous_storage)


def rollback_storage_restore(state: StorageRestoreState) -> None:
    if state.storage_root.exists():
        shutil.rmtree(state.storage_root)
    if state.previous_storage.exists():
        shutil.move(str(state.previous_storage), str(state.storage_root))


def cleanup_previous_storage(state: StorageRestoreState) -> None:
    if state.previous_storage.exists():
        shutil.rmtree(state.previous_storage)


def read_backup_info(path: Path) -> AdminBackupInfo:
    stat = path.stat()
    manifest = read_manifest_from_backup(path)
    return AdminBackupInfo(
        filename=path.name,
        size_bytes=stat.st_size,
        created_at=parse_manifest_datetime(manifest.get("created_at")) if manifest else datetime.fromtimestamp(stat.st_mtime, timezone.utc),
        format_version=int(manifest.get("format_version") or 0) if manifest else 0,
        database_engine=str(manifest.get("database_engine") or "unknown") if manifest else "unknown",
        storage_size_bytes=int(manifest.get("storage_size_bytes") or 0) if manifest else 0,
    )


def read_manifest_from_backup(path: Path) -> dict[str, object] | None:
    try:
        with ZipFile(path) as archive:
            with archive.open(MANIFEST_ENTRY) as manifest_file:
                return json.loads(manifest_file.read().decode("utf-8"))
    except (BadZipFile, KeyError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def parse_manifest_datetime(value: object) -> datetime:
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return datetime.now(timezone.utc)


def get_sqlite_database_path(database_url: str) -> str | None:
    database = make_url(database_url).database
    if not database or database == ":memory:":
        return None
    return str(Path(database).expanduser().resolve())


def get_directory_size(root: Path) -> int:
    if not root.exists():
        return 0
    return sum(path.stat().st_size for path in root.rglob("*") if path.is_file())


def ensure_path_inside(root: Path, path: Path) -> None:
    if not path.resolve().is_relative_to(root.resolve()):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Path escapes backup directory")
