"""Precopy while online, seal while stopped, then archive an isolated edition."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import uuid
from zipfile import ZIP_DEFLATED, ZipFile
from sqlalchemy.engine import make_url

from app.core.config import Settings
from app.core.database import create_database_engine, create_session_factory
from app.core.maintenance import ensure_no_restore_in_progress, maintenance_lock, require_writers_stopped
from app.core.storage import CHUNK_SIZE, get_storage_root
from app.modules.admin.backups import (
    BACKUP_EXTENSION, DATABASE_ENTRY, MANIFEST_ENTRY, STORAGE_PREFIX, add_storage_files,
    backup_sqlite_database, build_manifest, get_backup_root, get_sqlite_database_path,
    hash_file, normalize_snapshot_storage_paths, read_backup_info,
    validate_referenced_storage, validate_sqlite_snapshot,
)
from app.modules.admin.schemas import AdminBackupInfo

STATE_ENTRY = "snapshot-state.json"
STAGE_PREFIX = ".aisu-backup-snapshot-"


def new_backup_snapshot_path(settings: Settings) -> Path:
    return get_storage_root(settings).parent / f"{STAGE_PREFIX}{uuid.uuid4().hex}"


def _validate_stage_path(settings: Settings, directory: Path) -> Path:
    parent = get_storage_root(settings).parent
    if directory.is_symlink() or directory.parent.resolve() != parent or not re.fullmatch(r"\.aisu-backup-snapshot-[0-9a-f]{32}", directory.name):
        raise ValueError("Invalid backup snapshot directory")
    return directory.resolve()


def _validate_stage(settings: Settings, directory: Path) -> Path:
    directory = _validate_stage_path(settings, directory)
    if not directory.is_dir():
        raise ValueError("Backup snapshot directory is missing")
    if os.name == "posix":
        info = directory.stat()
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("Backup snapshot must be private to its owner")
    return directory


def discard_backup_snapshot(*, settings: Settings, directory: Path) -> None:
    # Validate the absolute boundary before any recursive removal, on every OS.
    directory = _validate_stage(settings, directory)
    shutil.rmtree(directory)


def _write_state(directory: Path, state: dict) -> None:
    temporary = directory / f".{STATE_ENTRY}.tmp"
    temporary.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    temporary.replace(directory / STATE_ENTRY)


def _read_state(settings: Settings, directory: Path, phase: str) -> tuple[Path, dict]:
    directory = _validate_stage(settings, directory)
    state_path = directory / STATE_ENTRY
    if state_path.is_symlink():
        raise ValueError("Backup snapshot state cannot be a symbolic link")
    state = json.loads(state_path.read_text(encoding="utf-8"))
    for name in (STORAGE_PREFIX, DATABASE_ENTRY, MANIFEST_ENTRY):
        if (directory / name).is_symlink():
            raise ValueError("Backup snapshot cannot contain symbolic links")
    if (state.get("version") != 1 or state.get("phase") != phase
            or state.get("storage_root") != str(get_storage_root(settings))
            or state.get("database_path") != get_sqlite_database_path(settings.database_url)):
        raise ValueError("Backup snapshot does not match this runtime or phase")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,63}", state.get("prefix", "")):
        raise ValueError("Invalid backup snapshot prefix")
    return directory, state


def _identity(info: os.stat_result) -> list[int]:
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def _storage_files(root: Path) -> list[Path]:
    files = []
    for path in root.rglob("*"):
        if path.is_symlink():
            raise RuntimeError("Storage contains a symbolic link")
        try:
            mode = path.stat().st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISREG(mode):
            files.append(path)
        elif not stat.S_ISDIR(mode):
            raise RuntimeError("Storage contains a non-regular file")
    return sorted(files)


def _copy_file(source: Path, destination: Path, *, strict: bool) -> dict | None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    try:
        before = source.stat()
        if source.is_symlink() or not stat.S_ISREG(before.st_mode):
            raise RuntimeError("Storage file is not regular")
        digest = hashlib.sha256()
        with source.open("rb") as reader, temporary.open("xb") as writer:
            opened = os.fstat(reader.fileno())
            if _identity(before) != _identity(opened):
                raise RuntimeError("Storage file changed during snapshot")
            for chunk in iter(lambda: reader.read(CHUNK_SIZE), b""):
                writer.write(chunk)
                digest.update(chunk)
            after_read = os.fstat(reader.fileno())
        after = source.stat()
        if _identity(before) != _identity(after_read) or _identity(before) != _identity(after):
            raise RuntimeError("Storage file changed during snapshot")
        shutil.copystat(source, temporary)
        temporary.replace(destination)
        return {"identity": _identity(after), "sha256": digest.hexdigest()}
    except (FileNotFoundError, RuntimeError):
        if strict:
            raise
        # A changing online file is deliberately absent from the precopy
        # index, so the stopped phase must copy it again.
        return None
    finally:
        temporary.unlink(missing_ok=True)


def prepare_backup_snapshot(*, settings: Settings, prefix: str = "scheduled", directory: Path | None = None) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,63}", prefix):
        raise ValueError("Invalid backup prefix")
    if make_url(settings.database_url).get_backend_name() != "sqlite" or not get_sqlite_database_path(settings.database_url):
        raise ValueError("Staged backups require a file-backed SQLite database")
    with maintenance_lock(settings):
        ensure_no_restore_in_progress(settings)
        root = get_storage_root(settings)
        directory = _validate_stage_path(settings, directory or new_backup_snapshot_path(settings))
        directory.mkdir(mode=0o700)
        try:
            files = _storage_files(root)
            size = 0
            for path in files:
                try:
                    size += path.stat().st_size
                except FileNotFoundError:
                    pass
            database = Path(get_sqlite_database_path(settings.database_url))
            database_size = database.stat().st_size
            wal = Path(f"{database}-wal")
            if wal.exists():
                database_size += wal.stat().st_size
            # Reserve both the precopy and a worst-case uncompressed archive,
            # including SQLite/WAL, plus headroom for the live application.
            if shutil.disk_usage(root.parent).free < (size + database_size) * 2 + 512 * 1024**2:
                raise RuntimeError("Insufficient free space for the backup snapshot")
            copied = {}
            for path in files:
                relative = path.relative_to(root).as_posix()
                info = _copy_file(path, directory / STORAGE_PREFIX / relative, strict=False)
                if info is not None:
                    copied[relative] = info
            _write_state(directory, {"version": 1, "phase": "prepared", "prefix": prefix,
                                    "storage_root": str(root), "database_path": get_sqlite_database_path(settings.database_url),
                                    "files": copied})
            return directory
        except BaseException:
            discard_backup_snapshot(settings=settings, directory=directory)
            raise


def capture_backup_snapshot(*, settings: Settings, directory: Path) -> dict[str, int]:
    with maintenance_lock(settings):
        ensure_no_restore_in_progress(settings)
        require_writers_stopped(settings)
        directory, state = _read_state(settings, directory, "prepared")
        root = get_storage_root(settings)
        snapshot_root = directory / STORAGE_PREFIX
        snapshot_root.mkdir(exist_ok=True)
        files = _storage_files(root)
        names = {path.relative_to(root).as_posix() for path in files}
        # Remove obsolete files before creating directories; this also handles
        # a file becoming a directory, or a directory becoming a file.
        for path in _storage_files(snapshot_root):
            if path.relative_to(snapshot_root).as_posix() not in names:
                path.unlink()
        for path in sorted(snapshot_root.rglob("*"), reverse=True):
            if path.is_dir() and not any(path.iterdir()):
                path.rmdir()
        captured = {}
        copied = reused = 0
        for path in files:
            relative = path.relative_to(root).as_posix()
            existing = state["files"].get(relative)
            target = snapshot_root / relative
            # Precopy already hashed these bytes. Device, inode, size and
            # nanosecond mtime/ctime identify unchanged files while writers
            # are stopped; archive verifies the private copy's checksum.
            if existing and existing["identity"] == _identity(path.stat()) and target.is_file():
                captured[relative] = existing
                reused += 1
            else:
                captured[relative] = _copy_file(path, target, strict=True)
                copied += 1
        engine = create_database_engine(settings)
        try:
            with create_session_factory(engine)() as session:
                database = directory / DATABASE_ENTRY
                backup_sqlite_database(session, database)
                normalize_snapshot_storage_paths(database, root)
                validate_sqlite_snapshot(database)
                references = validate_referenced_storage(database, snapshot_root)
                backup_id = f"{state['prefix']}-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
                manifest = build_manifest(session=session, settings=settings, backup_id=backup_id)
                manifest.update(database_sha256=hash_file(database), referenced_asset_count=references,
                                restorable=True, missing_storage_references=[], storage_file_count=len(captured),
                                storage_files={name: info["sha256"] for name, info in captured.items()})
        finally:
            engine.dispose()
        (directory / MANIFEST_ENTRY).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        state.update(phase="captured", files=captured, backup_id=backup_id)
        _write_state(directory, state)
        return {"copied": copied, "reused": reused, "files": len(captured)}


def archive_backup_snapshot(*, settings: Settings, directory: Path) -> AdminBackupInfo:
    with maintenance_lock(settings):
        ensure_no_restore_in_progress(settings)
        directory, state = _read_state(settings, directory, "captured")
        manifest = json.loads((directory / MANIFEST_ENTRY).read_text(encoding="utf-8"))
        if manifest.get("backup_id") != state.get("backup_id") or not re.fullmatch(
                re.escape(state["prefix"]) + r"-\d{8}-\d{6}-[0-9a-f]{8}", state.get("backup_id", "")):
            raise ValueError("Invalid captured backup identity")
        if manifest.get("storage_files") != {name: info["sha256"] for name, info in state["files"].items()}:
            raise ValueError("Captured backup file inventory changed")
        database = directory / DATABASE_ENTRY
        if hash_file(database) != manifest["database_sha256"]:
            raise RuntimeError("Backup snapshot database checksum changed")
        validate_sqlite_snapshot(database)
        validate_referenced_storage(database, directory / STORAGE_PREFIX)
        root = get_backup_root(settings)
        destination = root / f"{state['backup_id']}{BACKUP_EXTENSION}"
        temporary = root / f".{state['backup_id']}{BACKUP_EXTENSION}.tmp"
        if destination.exists() or temporary.exists():
            raise RuntimeError("Backup archive already exists")
        try:
            with ZipFile(temporary, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
                archive.write(database, DATABASE_ENTRY)
                add_storage_files(archive, directory / STORAGE_PREFIX, expected_checksums=manifest["storage_files"])
                archive.writestr(MANIFEST_ENTRY, json.dumps(manifest, ensure_ascii=False, indent=2))
            if hash_file(database) != manifest["database_sha256"]:
                raise RuntimeError("Backup snapshot database changed during archiving")
            temporary.replace(destination)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
        return read_backup_info(destination)
