from dataclasses import replace
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from types import SimpleNamespace
from zipfile import ZipFile

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.database import create_database_engine, create_session_factory
from app.core import maintenance
from app.main import create_app
from app.modules.admin import backup_snapshot as snapshots
from app.modules.admin.backup_cli import run_offline_restore
from app.modules.admin.backups import extract_backup_archive, get_backup_root


@pytest.fixture
def runtime(tmp_path):
    settings = Settings(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'live.sqlite3'}",
        storage_root=str(tmp_path / "storage"),
        seed_demo_data=True,
    )
    with TestClient(create_app(settings)):
        yield settings


def put(settings, name, body=b"original"):
    path = Path(settings.storage_root) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return path


def prepare(settings):
    return snapshots.prepare_backup_snapshot(settings=settings)


def capture(settings, directory):
    return snapshots.capture_backup_snapshot(settings=settings, directory=directory)


def archive(settings, directory):
    return snapshots.archive_backup_snapshot(settings=settings, directory=directory)


def test_snapshot_prepares_online_and_archives_sealed_edition_after_live_files_change(
    runtime, tmp_path
):
    source = put(runtime, "notes/chapter.txt")
    directory = prepare(runtime)
    assert not os.path.samefile(source, directory / "storage/notes/chapter.txt")
    result = capture(runtime, directory)
    assert result == {"copied": 0, "reused": 1, "files": 1}
    source.write_bytes(b"changed after writers resumed")
    put(runtime, "new.txt", b"arrived after capture")
    backup = archive(runtime, directory)
    with ZipFile(get_backup_root(runtime) / backup.filename) as z:
        assert z.read("storage/notes/chapter.txt") == b"original"
        assert "storage/new.txt" not in z.namelist()
    manifest = extract_backup_archive(
        get_backup_root(runtime) / backup.filename, tmp_path / "restore-drill", runtime
    )
    assert manifest["storage_file_count"] == 1 and manifest["restorable"]
    snapshots.discard_backup_snapshot(settings=runtime, directory=directory)
    assert (
        not directory.exists()
        and source.read_bytes() == b"changed after writers resumed"
    )


def test_capture_reconciles_same_size_replace_even_with_preserved_modification_time(
    runtime,
):
    source = put(runtime, "chapter.txt", b"before")
    directory = prepare(runtime)
    before = source.stat()
    replacement = put(runtime, "replacement", b"after!")
    os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
    replacement.replace(source)
    assert capture(runtime, directory)["copied"] == 1
    backup = archive(runtime, directory)
    with ZipFile(get_backup_root(runtime) / backup.filename) as z:
        assert z.read("storage/chapter.txt") == b"after!"


def test_capture_reuses_unchanged_precopy_without_hashing_live_files_again(
    runtime, monkeypatch
):
    source = put(runtime, "chapter.txt", b"before")
    directory = prepare(runtime)
    original_hash_file = snapshots.hash_file

    def hash_without_live_reread(path):
        assert path != source
        return original_hash_file(path)

    monkeypatch.setattr(snapshots, "hash_file", hash_without_live_reread)
    result = capture(runtime, directory)
    assert result["copied"] == 0 and result["reused"] == 1
    backup = archive(runtime, directory)
    with ZipFile(get_backup_root(runtime) / backup.filename) as z:
        assert z.read("storage/chapter.txt") == b"before"


def test_capture_adds_changes_removes_deleted_files_and_handles_file_directory_swaps(
    runtime,
):
    changed = put(runtime, "changed", b"old")
    removed = put(runtime, "removed")
    old_file = put(runtime, "file-to-dir")
    child = put(runtime, "dir-to-file/child")
    directory = prepare(runtime)
    changed.write_bytes(b"new value")
    removed.unlink()
    old_file.unlink()
    child.unlink()
    child.parent.rmdir()
    put(runtime, "file-to-dir/child", b"nested")
    put(runtime, "dir-to-file", b"flat")
    put(runtime, "added", b"added")
    result = capture(runtime, directory)
    assert result["files"] == result["copied"] == 4
    backup = archive(runtime, directory)
    with ZipFile(get_backup_root(runtime) / backup.filename) as z:
        names = {n for n in z.namelist() if n.startswith("storage/")}
        assert names == {
            "storage/changed",
            "storage/file-to-dir/child",
            "storage/dir-to-file",
            "storage/added",
        }
        assert z.read("storage/changed") == b"new value"


def test_online_file_mutated_during_read_is_discarded_then_copied_while_stopped(
    runtime, monkeypatch
):
    source = put(runtime, "chapter.txt", b"a" * 4096)
    original_open = Path.open

    class ChangingReader:
        def __init__(self):
            self.reader = original_open(source, "rb")
            self.changed = False

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.reader.close()

        def fileno(self):
            return self.reader.fileno()

        def read(self, size):
            chunk = self.reader.read(size)
            if chunk and not self.changed:
                self.changed = True
                with original_open(source, "wb") as writer:
                    writer.write(b"b" * 4096)
            return chunk

    def opening(path, mode="r", *args, **kwargs):
        if path == source and mode == "rb":
            return ChangingReader()
        return original_open(path, mode, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "open", opening)
        directory = prepare(runtime)
    state = json.loads((directory / snapshots.STATE_ENTRY).read_text("utf-8"))
    assert "chapter.txt" not in state["files"]
    assert capture(runtime, directory)["copied"] == 1
    assert (directory / "storage/chapter.txt").read_bytes() == b"b" * 4096


def test_prepare_failure_and_space_exhaustion_leave_live_files_and_no_temporary_snapshot(
    runtime, monkeypatch
):
    source = put(runtime, "keep.txt")
    with monkeypatch.context() as patch:
        patch.setattr(snapshots.shutil, "disk_usage", lambda _: SimpleNamespace(free=0))
        with pytest.raises(RuntimeError, match="Insufficient free space"):
            prepare(runtime)
    with monkeypatch.context() as patch:
        patch.setattr(
            snapshots,
            "_copy_file",
            lambda *args, **kwargs: (_ for _ in ()).throw(OSError("disk failure")),
        )
        with pytest.raises(OSError, match="disk failure"):
            prepare(runtime)
    assert source.read_bytes() == b"original"
    assert not list(source.parent.glob(snapshots.STAGE_PREFIX + "*"))
    assert not list(source.parent.parent.glob(snapshots.STAGE_PREFIX + "*"))


def test_space_reservation_includes_sqlite_and_wal(runtime, monkeypatch):
    put(runtime, "chapter.txt")
    # Enough for the tiny library and fixed headroom, but not two copies of
    # SQLite. Refuse online, before copying or stopping any service.
    monkeypatch.setattr(
        snapshots.shutil,
        "disk_usage",
        lambda _: SimpleNamespace(free=512 * 1024**2 + 1024),
    )
    with pytest.raises(RuntimeError, match="Insufficient free space"):
        prepare(runtime)
    assert not list(
        Path(runtime.storage_root).parent.glob(snapshots.STAGE_PREFIX + "*")
    )


def test_planned_path_exists_only_after_prepare_and_cannot_overwrite_an_existing_snapshot(
    runtime,
):
    directory = snapshots.new_backup_snapshot_path(runtime)
    assert not directory.exists()
    assert (
        snapshots.prepare_backup_snapshot(settings=runtime, directory=directory)
        == directory
    )
    state = (directory / snapshots.STATE_ENTRY).read_bytes()
    with pytest.raises(FileExistsError):
        snapshots.prepare_backup_snapshot(settings=runtime, directory=directory)
    assert (directory / snapshots.STATE_ENTRY).read_bytes() == state


@pytest.mark.parametrize("damage", ["modified", "added", "removed", "database"])
def test_damaged_sealed_snapshot_never_publishes_partial_backup(runtime, damage):
    put(runtime, "chapter.txt")
    directory = prepare(runtime)
    capture(runtime, directory)
    if damage == "modified":
        (directory / "storage/chapter.txt").write_bytes(b"corrupted")
    if damage == "added":
        (directory / "storage/extra.txt").write_bytes(b"unexpected")
    if damage == "removed":
        (directory / "storage/chapter.txt").unlink()
    if damage == "database":
        (directory / "database.sqlite3").write_bytes(b"invalid database")
    with pytest.raises(RuntimeError):
        archive(runtime, directory)
    assert not list(get_backup_root(runtime).glob("*.zip"))
    assert not list(get_backup_root(runtime).glob("*.tmp"))


def test_capture_rejects_missing_referenced_file_and_does_not_seal(runtime):
    directory = prepare(runtime)
    engine = create_database_engine(runtime)
    try:
        with create_session_factory(engine)() as session:
            session.connection().exec_driver_sql(
                "UPDATE books SET original_file_path='missing.epub' WHERE id=(SELECT id FROM books LIMIT 1)"
            )
            session.commit()
    finally:
        engine.dispose()
    with pytest.raises(RuntimeError, match="missing storage"):
        capture(runtime, directory)
    assert (
        json.loads((directory / snapshots.STATE_ENTRY).read_text("utf-8"))["phase"]
        == "prepared"
    )


def test_capture_requires_writers_stopped_before_copying_or_sealing(
    runtime, monkeypatch
):
    directory = prepare(runtime)

    def refuse(_):
        raise RuntimeError("Stop writer first")

    monkeypatch.setattr(snapshots, "require_writers_stopped", refuse)
    with pytest.raises(RuntimeError, match="Stop writer"):
        capture(runtime, directory)
    assert not (directory / "database.sqlite3").exists()


@pytest.mark.parametrize("code", [0, 1])
def test_production_writer_check_fails_closed_for_active_or_unknown_state(
    runtime, monkeypatch, code
):
    monkeypatch.setattr(maintenance, "os", SimpleNamespace(name="posix"))
    monkeypatch.setattr(
        maintenance.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=code),
    )
    with pytest.raises(RuntimeError, match="Stop|Could not verify"):
        maintenance.require_writers_stopped(replace(runtime, environment="production"))


def test_wrong_runtime_and_reusing_captured_phase_are_rejected(runtime):
    directory = prepare(runtime)
    other = replace(
        runtime,
        database_url=runtime.database_url.replace("live.sqlite3", "other.sqlite3"),
    )
    with pytest.raises(ValueError, match="runtime or phase"):
        capture(other, directory)
    capture(runtime, directory)
    with pytest.raises(ValueError, match="runtime or phase"):
        capture(runtime, directory)


def test_discard_refuses_paths_outside_its_private_temporary_directory(
    runtime, tmp_path
):
    protected = tmp_path / "keep"
    protected.mkdir()
    (protected / "note").write_text("keep", encoding="utf-8")
    with pytest.raises(ValueError, match="snapshot directory"):
        snapshots.discard_backup_snapshot(settings=runtime, directory=protected)
    assert (protected / "note").read_text("utf-8") == "keep"


def test_restore_marker_blocks_online_prepare_and_archive(runtime):
    directory = prepare(runtime)
    capture(runtime, directory)
    marker = maintenance.maintenance_marker(runtime)
    marker.write_text("incomplete restore", encoding="utf-8")
    with pytest.raises(RuntimeError, match="incomplete"):
        prepare(runtime)
    with pytest.raises(RuntimeError, match="incomplete"):
        archive(runtime, directory)


def test_cli_phases_keep_existing_restore_format_and_automatic_retention(runtime):
    put(runtime, "chapter.txt")
    env = {
        **os.environ,
        "AISU_DATABASE_URL": runtime.database_url,
        "AISU_STORAGE_ROOT": runtime.storage_root,
        "AISU_ENVIRONMENT": "development",
    }

    def cli(*args):
        return subprocess.check_output(
            [sys.executable, "-m", "app.modules.admin.backup_cli", *args],
            cwd=Path(__file__).resolve().parents[1],
            env=env,
            text=True,
        ).strip()

    for _ in range(3):
        directory = cli("snapshot-path")
        assert not Path(directory).exists()
        assert (
            cli("prepare", "--prefix", "snapshot-test", "--directory", directory)
            == directory
        )
        assert "snapshot_captured=" in cli("capture", "--directory", directory)
        assert "created=snapshot-test-" in cli(
            "archive", "--directory", directory, "--keep-count", "2"
        )
        cli("discard-snapshot", "--directory", directory)
    assert len(list(get_backup_root(runtime).glob("snapshot-test-*.zip"))) == 2
    assert not list(
        Path(runtime.storage_root).parent.glob(snapshots.STAGE_PREFIX + "*")
    )


def test_sealed_backup_restores_into_an_isolated_runtime_after_live_writes(
    runtime, tmp_path
):
    source = put(runtime, "notes/chapter.txt", b"captured chapter")
    live_database = snapshots.get_sqlite_database_path(runtime.database_url)
    with sqlite3.connect(live_database) as db:
        original_title = db.execute("SELECT title FROM books WHERE id='b2'").fetchone()[
            0
        ]
    directory = prepare(runtime)
    capture(runtime, directory)
    source.write_bytes(b"live changed after capture")
    with sqlite3.connect(live_database) as db:
        db.execute("UPDATE books SET title='Live changed title' WHERE id='b2'")
    backup = archive(runtime, directory)

    destination = tmp_path / "isolated-restore"
    destination.mkdir()
    restored = replace(
        runtime,
        database_url=f"sqlite+pysqlite:///{destination / 'restored.sqlite3'}",
        storage_root=str(destination / "storage"),
    )
    with TestClient(create_app(restored)):
        pass
    run_offline_restore(
        settings=restored,
        backup_file=get_backup_root(runtime) / backup.filename,
        confirmation="RESTORE",
    )
    assert (
        destination / "storage/notes/chapter.txt"
    ).read_bytes() == b"captured chapter"
    with sqlite3.connect(destination / "restored.sqlite3") as db:
        assert (
            db.execute("SELECT title FROM books WHERE id='b2'").fetchone()[0]
            == original_title
        )
    assert source.read_bytes() == b"live changed after capture"
    with sqlite3.connect(live_database) as db:
        assert (
            db.execute("SELECT title FROM books WHERE id='b2'").fetchone()[0]
            == "Live changed title"
        )


def test_interrupted_copy_and_archive_remove_their_partial_outputs(
    runtime, monkeypatch
):
    put(runtime, "chapter.txt")

    def interrupted(*args, **kwargs):
        raise SystemExit(143)

    with monkeypatch.context() as patch:
        patch.setattr(snapshots, "_copy_file", interrupted)
        with pytest.raises(SystemExit):
            prepare(runtime)
    assert not list(
        Path(runtime.storage_root).parent.glob(snapshots.STAGE_PREFIX + "*")
    )

    directory = prepare(runtime)
    capture(runtime, directory)
    monkeypatch.setattr(snapshots, "add_storage_files", interrupted)
    with pytest.raises(SystemExit):
        archive(runtime, directory)
    assert not list(get_backup_root(runtime).glob("*.zip"))
    assert not list(get_backup_root(runtime).glob("*.tmp"))
