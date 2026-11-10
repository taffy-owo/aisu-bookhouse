from io import BytesIO
from contextlib import closing
from dataclasses import replace
import json
import hashlib
from pathlib import Path
import sqlite3
import os
import subprocess
import sys
import tempfile
import shutil
from zipfile import ZipFile

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.database import create_database_engine, create_session_factory
from app.main import create_app
from app.modules.admin.backup_cli import maintenance_marker, run_offline_restore, run_scheduled_backup
from app.modules.admin import backup_cli
from app.modules.admin.backups import create_backup, extract_backup_archive, get_backup_root, get_sqlite_database_path, list_backup_files, prune_backup_files
from app.modules.uploads.worker import process_next_upload_task
from app.core.maintenance import maintenance_lock


def make_backup(settings: Settings, *, prefix: str = "aisu-bookhouse"):
    engine = create_database_engine(settings)
    try:
        with create_session_factory(engine)() as session:
            return create_backup(session=session, settings=settings, prefix=prefix)
    finally:
        engine.dispose()


def test_admin_can_list_and_download_offline_backup(client: TestClient, auth_headers: dict[str, str]) -> None:
    settings = client.app.state.settings
    storage_root = Path(settings.storage_root)
    (storage_root / "manual").mkdir(parents=True)
    (storage_root / "manual" / "note.txt").write_text("keep me", encoding="utf-8")
    assert client.post("/api/v1/admin/backups", headers=auth_headers).status_code == 409

    with client.app.state.db_session_factory() as session:
        created = create_backup(session=session, settings=settings)
    listed = client.get("/api/v1/admin/backups", headers=auth_headers)
    assert listed.status_code == 200
    assert listed.json()["backups"][0]["filename"] == created.filename
    downloaded = client.get(f"/api/v1/admin/backups/{created.filename}/download", headers=auth_headers)
    assert downloaded.status_code == 200
    with ZipFile(BytesIO(downloaded.content)) as archive:
        assert archive.read("storage/manual/note.txt") == b"keep me"
        assert archive.read("database.sqlite3")


def test_admin_backup_rejects_regular_user(client: TestClient, auth_headers: dict[str, str]) -> None:
    invitation = client.post("/api/v1/invitations/me", headers=auth_headers).json()
    registered = client.post("/api/v1/auth/register", json={
        "email": "reader@example.com", "invitation_code": invitation["code"],
        "nickname": "Reader", "password": "reader-password",
    })
    headers = {"Authorization": f"Bearer {registered.json()['access_token']}"}
    assert client.get("/api/v1/admin/backups", headers=headers).status_code == 403
    assert client.post("/api/v1/admin/backups/restore", headers=headers).status_code == 403


def test_online_restore_is_disabled(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.post("/api/v1/admin/backups/restore", headers=auth_headers)
    assert response.status_code == 409
    assert "backup_cli restore" in response.json()["detail"]


def test_offline_restore_requires_confirmation(tmp_path: Path) -> None:
    settings = Settings(database_url=f"sqlite+pysqlite:///{tmp_path / 'db.sqlite3'}", storage_root=str(tmp_path / "storage"))
    with pytest.raises(ValueError, match="RESTORE"):
        run_offline_restore(backup_file=tmp_path / "missing.zip", confirmation="restore", settings=settings)
    assert not maintenance_marker(settings).exists()


def test_offline_restore_rejects_oversize_and_unsafe_archive(tmp_path: Path) -> None:
    settings = Settings(database_url=f"sqlite+pysqlite:///{tmp_path / 'db.sqlite3'}", storage_root=str(tmp_path / "storage"), max_backup_restore_size_bytes=16)
    oversized = tmp_path / "oversized.zip"
    oversized.write_bytes(b"x" * 17)
    with pytest.raises(ValueError, match="size limit"):
        run_offline_restore(backup_file=oversized, confirmation="RESTORE", settings=settings)

    unsafe = tmp_path / "unsafe.zip"
    with ZipFile(unsafe, "w") as archive:
        archive.writestr("manifest.json", json.dumps({"format_version": 1}))
        archive.writestr("database.sqlite3", b"placeholder")
        archive.writestr("storage/../escape.txt", "nope")
    with pytest.raises(HTTPException, match="unsafe path"):
        extract_backup_archive(unsafe, tmp_path / "extracted", Settings(storage_root=str(tmp_path / "storage")))


def test_offline_restore_rejects_invalid_database_before_switch(tmp_path: Path) -> None:
    settings = Settings(database_url=f"sqlite+pysqlite:///{tmp_path / 'db.sqlite3'}", storage_root=str(tmp_path / "storage"), seed_demo_data=True)
    with TestClient(create_app(settings)):
        pass
    storage_root = Path(settings.storage_root)
    (storage_root / "manual").mkdir(parents=True)
    (storage_root / "manual" / "note.txt").write_text("before", encoding="utf-8")
    invalid = tmp_path / "invalid.zip"
    with ZipFile(invalid, "w") as archive:
        archive.writestr("manifest.json", json.dumps({"format_version": 1}))
        archive.writestr("database.sqlite3", b"not a sqlite database")
        archive.writestr("storage/manual/note.txt", "after")
    with pytest.raises(HTTPException, match="invalid"):
        run_offline_restore(backup_file=invalid, confirmation="RESTORE", settings=settings)
    assert (storage_root / "manual" / "note.txt").read_text(encoding="utf-8") == "before"


def test_offline_restore_replaces_database_and_storage(tmp_path: Path) -> None:
    settings = Settings(database_url=f"sqlite+pysqlite:///{tmp_path / 'db.sqlite3'}", storage_root=str(tmp_path / "storage"), seed_demo_data=True)
    with TestClient(create_app(settings)):
        pass
    storage_root = Path(settings.storage_root)
    (storage_root / "manual").mkdir(parents=True)
    note = storage_root / "manual" / "note.txt"
    note.write_text("before", encoding="utf-8")
    backup = make_backup(settings)
    with closing(sqlite3.connect(tmp_path / "db.sqlite3")) as db:
        with db:
            db.execute("DELETE FROM books WHERE id = 'b2'")
    note.write_text("after", encoding="utf-8")

    restored, safety = run_offline_restore(backup_file=get_backup_root(settings) / backup.filename, confirmation="RESTORE", settings=settings)
    assert restored.filename == backup.filename
    assert safety.filename.startswith("pre-restore-")
    assert note.read_text(encoding="utf-8") == "before"
    with closing(sqlite3.connect(tmp_path / "db.sqlite3")) as db:
        assert db.execute("SELECT count(*) FROM books WHERE id = 'b2'").fetchone()[0] == 1
    assert not maintenance_marker(settings).exists()


def test_backups_store_relative_file_references_without_changing_live_database(tmp_path: Path) -> None:
    settings = Settings(database_url=f"sqlite+pysqlite:///{tmp_path / 'db.sqlite3'}", storage_root=str(tmp_path / "storage"), seed_demo_data=True)
    with TestClient(create_app(settings)):
        pass
    source = Path(settings.storage_root) / "manual" / "book.txt"
    source.parent.mkdir(parents=True)
    source.write_text("portable book", encoding="utf-8")
    with closing(sqlite3.connect(tmp_path / "db.sqlite3")) as db, db:
        db.execute("update books set original_file_path=? where id='b2'", (str(source),))
    backup = make_backup(settings)
    extracted = tmp_path / "extracted"
    manifest = extract_backup_archive(get_backup_root(settings) / backup.filename, extracted, settings)
    assert manifest["storage_root"] == str(Path(settings.storage_root).resolve())
    with closing(sqlite3.connect(extracted / "database.sqlite3")) as db:
        assert db.execute("select original_file_path from books where id='b2'").fetchone()[0] == "manual/book.txt"
    with closing(sqlite3.connect(tmp_path / "db.sqlite3")) as db:
        assert db.execute("select original_file_path from books where id='b2'").fetchone()[0] == str(source)


@pytest.mark.parametrize("relocated", [False, True])
def test_legacy_absolute_paths_restore_to_archived_storage(tmp_path: Path, relocated: bool) -> None:
    original = Settings(database_url=f"sqlite+pysqlite:///{tmp_path / 'db.sqlite3'}", storage_root=str(tmp_path / "storage"), seed_demo_data=True)
    with TestClient(create_app(original)):
        pass
    source = Path(original.storage_root) / "legacy" / "book.txt"
    source.parent.mkdir(parents=True)
    source.write_text("archived body", encoding="utf-8")
    with closing(sqlite3.connect(tmp_path / "db.sqlite3")) as db, db:
        db.execute("update books set original_file_path='legacy/book.txt' where id='b2'")
    backup = make_backup(original)
    # Reconstruct the old archive format: a valid checksum but an absolute DB
    # reference and no manifest field recording the original storage root.
    snapshot = tmp_path / "legacy.sqlite3"
    with ZipFile(get_backup_root(original) / backup.filename) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    snapshot.write_bytes(entries["database.sqlite3"])
    with closing(sqlite3.connect(snapshot)) as db, db:
        db.execute("update books set original_file_path=? where id='b2'", (str(source),))
    entries["database.sqlite3"] = snapshot.read_bytes()
    manifest = json.loads(entries["manifest.json"])
    manifest.pop("storage_root", None)
    manifest["database_sha256"] = hashlib.sha256(entries["database.sqlite3"]).hexdigest()
    entries["manifest.json"] = json.dumps(manifest).encode()
    legacy = get_backup_root(original) / "legacy.zip"
    with ZipFile(legacy, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    target = original
    arguments = {}
    if relocated:
        target = replace(original, database_url=f"sqlite+pysqlite:///{tmp_path / 'relocated.sqlite3'}", storage_root=str(tmp_path / "relocated-storage"))
        with TestClient(create_app(target)):
            pass
        arguments["legacy_storage_root"] = Path(original.storage_root)
    source.write_text("live content must not be read during restore", encoding="utf-8")
    run_offline_restore(backup_file=legacy, confirmation="RESTORE", settings=target, **arguments)
    assert (Path(target.storage_root) / "legacy" / "book.txt").read_text(encoding="utf-8") == "archived body"
    with closing(sqlite3.connect(get_sqlite_database_path(target.database_url))) as db:
        assert db.execute("select original_file_path from books where id='b2'").fetchone()[0] == "legacy/book.txt"
    if relocated:
        assert source.read_text(encoding="utf-8") == "live content must not be read during restore"


def test_offline_restore_preserves_damaged_current_state_as_nonrestorable_safety_backup(tmp_path: Path) -> None:
    settings = Settings(database_url=f"sqlite+pysqlite:///{tmp_path / 'db.sqlite3'}", storage_root=str(tmp_path / "storage"), seed_demo_data=True)
    with TestClient(create_app(settings)):
        pass
    original = make_backup(settings)
    with closing(sqlite3.connect(tmp_path / "db.sqlite3")) as db:
        with db:
            db.execute("UPDATE books SET original_file_path = 'missing/source.epub' WHERE id = 'b2'")
    with pytest.raises(RuntimeError, match="missing storage files"):
        make_backup(settings)

    restored, safety = run_offline_restore(backup_file=get_backup_root(settings) / original.filename, confirmation="RESTORE", settings=settings)
    assert restored.filename == original.filename
    with ZipFile(get_backup_root(settings) / safety.filename) as archive:
        manifest = json.loads(archive.read("manifest.json"))
    assert manifest["restorable"] is False
    assert manifest["missing_storage_references"] == ["missing/source.epub"]
    with pytest.raises(HTTPException, match="incomplete safety backup"):
        extract_backup_archive(get_backup_root(settings) / safety.filename, tmp_path / "unsafe-extracted", settings)


@pytest.mark.skipif(os.name != "posix", reason="Requires POSIX flock across processes")
def test_maintenance_lock_rejects_second_process_then_releases(tmp_path: Path) -> None:
    settings = Settings(storage_root=str(tmp_path / "storage"))
    code = (
        "from app.core.config import Settings; from app.core.maintenance import maintenance_lock; "
        "import sys; "
        "settings=Settings(storage_root=sys.argv[1]); "
        "with maintenance_lock(settings): print('acquired')"
    )
    # Compound statements need their own line after the imports.
    code = code.replace("; with maintenance_lock", "\nwith maintenance_lock")
    command = [sys.executable, "-c", code, settings.storage_root]
    with maintenance_lock(settings):
        blocked = subprocess.run(command, cwd=Path(__file__).parents[1], capture_output=True, text=True, timeout=20)
        assert blocked.returncode != 0
        assert "Another maintenance operation is running" in blocked.stderr
    acquired = subprocess.run(command, cwd=Path(__file__).parents[1], capture_output=True, text=True, timeout=20)
    assert acquired.returncode == 0, acquired.stderr
    assert acquired.stdout.strip() == "acquired"


@pytest.mark.skipif(os.name != "posix", reason="Requires POSIX process interruption")
def test_killed_restore_keeps_marker_and_blocks_app_and_worker(tmp_path: Path) -> None:
    settings = Settings(database_url=f"sqlite+pysqlite:///{tmp_path / 'db.sqlite3'}", storage_root=str(tmp_path / "storage"), seed_demo_data=True)
    with TestClient(create_app(settings)):
        pass
    backup = make_backup(settings)
    code = """
import os, sys
from pathlib import Path
from app.core.config import Settings
from app.modules.admin import backup_cli
backup_cli.restore_storage = lambda **_kwargs: os._exit(77)
settings = Settings(database_url=sys.argv[1], storage_root=sys.argv[2], seed_demo_data=True)
backup_cli.run_offline_restore(backup_file=Path(sys.argv[3]), confirmation='RESTORE', settings=settings)
"""
    result = subprocess.run([sys.executable, "-c", code, settings.database_url, settings.storage_root,
                             str(get_backup_root(settings) / backup.filename)], cwd=Path(__file__).parents[1], timeout=30)
    assert result.returncode == 77
    assert maintenance_marker(settings).exists()
    with pytest.raises(RuntimeError, match="restore is incomplete"):
        create_app(settings)
    with pytest.raises(RuntimeError, match="restore is incomplete"):
        process_next_upload_task(settings=settings)


@pytest.mark.skipif(os.name != "posix" or getattr(os, "geteuid", lambda: -1)() != 0,
                    reason="Requires POSIX root and aisu-bookhouse service account")
def test_restored_files_allow_real_service_uid_to_read_and_write(monkeypatch) -> None:
    import pwd
    account = pwd.getpwnam("aisu-bookhouse")
    root = Path(tempfile.mkdtemp(prefix="aisu-service-restore-"))
    try:
        os.chmod(root, 0o755)
        os.chown(root, account.pw_uid, account.pw_gid)
        settings = Settings(database_url=f"sqlite+pysqlite:///{root / 'db.sqlite3'}", storage_root=str(root / "storage"), seed_demo_data=True)
        with TestClient(create_app(settings)):
            pass
        note = root / "storage" / "chapters" / "chapter.txt"
        note.parent.mkdir(parents=True)
        note.write_text("original chapter", encoding="utf-8")
        backup = make_backup(settings)
        note.write_text("damaged chapter", encoding="utf-8")
        monkeypatch.setattr(backup_cli, "require_writers_stopped", lambda _settings: None)
        run_offline_restore(backup_file=get_backup_root(settings) / backup.filename,
                            confirmation="RESTORE", settings=replace(settings, environment="production"))
        for path in (root / "db.sqlite3", root / "db.sqlite3-wal", root / "db.sqlite3-shm"):
            if path.exists():
                assert path.stat().st_uid == account.pw_uid
        code = """
import sqlite3, sys
from pathlib import Path
root = Path(sys.argv[1])
assert (root / 'storage/chapters/chapter.txt').read_text(encoding='utf-8') == 'original chapter'
with sqlite3.connect(root / 'db.sqlite3') as db:
    owner_id, reader_type = db.execute("SELECT owner_id, reader_type FROM books WHERE id = 'b2'").fetchone()
    db.execute("INSERT INTO reading_progress (user_id, book_id, reader_type, progress_percent, updated_at) "
               "VALUES (?, 'b2', ?, 37, CURRENT_TIMESTAMP) "
               "ON CONFLICT(user_id, book_id) DO UPDATE SET progress_percent = excluded.progress_percent",
               (owner_id, reader_type))
    assert db.execute("SELECT progress_percent FROM reading_progress WHERE user_id = ? AND book_id = 'b2'", (owner_id,)).fetchone()[0] == 37
uploads = root / 'storage/uploads'
uploads.mkdir(exist_ok=True)
(uploads / 'service-upload.txt').write_text('upload', encoding='utf-8')
print('service-read-progress-upload-ok')
"""
        def drop_privileges() -> None:
            os.setgroups([])
            os.setgid(account.pw_gid)
            os.setuid(account.pw_uid)
        result = subprocess.run([sys.executable, "-c", code, str(root)], cwd="/", preexec_fn=drop_privileges,
                                capture_output=True, text=True, timeout=20)
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == "service-read-progress-upload-ok"
    finally:
        shutil.rmtree(root)


def test_maintenance_marker_prevents_worker_claim(tmp_path: Path) -> None:
    settings = Settings(database_url=f"sqlite+pysqlite:///{tmp_path / 'db.sqlite3'}", storage_root=str(tmp_path / "storage"))
    maintenance_marker(settings).write_text("Restoring", encoding="utf-8")
    with pytest.raises(RuntimeError, match="restore is incomplete"):
        process_next_upload_task(settings=settings)


def test_offline_restore_rolls_back_storage_when_database_swap_fails(tmp_path: Path, monkeypatch) -> None:
    settings = Settings(database_url=f"sqlite+pysqlite:///{tmp_path / 'db.sqlite3'}", storage_root=str(tmp_path / "storage"), seed_demo_data=True)
    with TestClient(create_app(settings)):
        pass
    storage_root = Path(settings.storage_root)
    (storage_root / "manual").mkdir(parents=True)
    note = storage_root / "manual" / "note.txt"
    note.write_text("backup", encoding="utf-8")
    backup = make_backup(settings)
    note.write_text("current", encoding="utf-8")
    with closing(sqlite3.connect(tmp_path / "db.sqlite3")) as db:
        with db:
            db.execute("DELETE FROM books WHERE id = 'b2'")

    original_replace = backup_cli.os.replace
    def fail_database_publish(source, destination):
        if str(source).endswith(".restore-new"):
            raise OSError("injected database swap failure")
        return original_replace(source, destination)
    monkeypatch.setattr(backup_cli.os, "replace", fail_database_publish)

    with pytest.raises(OSError, match="injected database swap failure"):
        run_offline_restore(backup_file=get_backup_root(settings) / backup.filename, confirmation="RESTORE", settings=settings)
    assert note.read_text(encoding="utf-8") == "current"
    with closing(sqlite3.connect(tmp_path / "db.sqlite3")) as db:
        assert db.execute("SELECT count(*) FROM books WHERE id = 'b2'").fetchone()[0] == 0
    assert not maintenance_marker(settings).exists()


def test_offline_restore_rolls_back_both_stores_when_ownership_fails(tmp_path: Path, monkeypatch) -> None:
    settings = Settings(database_url=f"sqlite+pysqlite:///{tmp_path / 'db.sqlite3'}", storage_root=str(tmp_path / "storage"), seed_demo_data=True)
    with TestClient(create_app(settings)):
        pass
    note = Path(settings.storage_root) / "note.txt"
    note.parent.mkdir(parents=True, exist_ok=True)
    note.write_text("backup", encoding="utf-8")
    backup = make_backup(settings)
    note.write_text("current", encoding="utf-8")
    with closing(sqlite3.connect(tmp_path / "db.sqlite3")) as db:
        with db:
            db.execute("DELETE FROM books WHERE id = 'b2'")
    def fail_ownership(_settings, _database_path):
        raise OSError("injected chown failure")
    monkeypatch.setattr(backup_cli, "restore_runtime_ownership", fail_ownership)

    with pytest.raises(OSError, match="injected chown failure"):
        run_offline_restore(backup_file=get_backup_root(settings) / backup.filename, confirmation="RESTORE", settings=settings)
    assert note.read_text(encoding="utf-8") == "current"
    with closing(sqlite3.connect(tmp_path / "db.sqlite3")) as db:
        assert db.execute("SELECT count(*) FROM books WHERE id = 'b2'").fetchone()[0] == 0
    assert not maintenance_marker(settings).exists()


def test_maintenance_marker_prevents_app_start(tmp_path: Path) -> None:
    settings = Settings(database_url=f"sqlite+pysqlite:///{tmp_path / 'db.sqlite3'}", storage_root=str(tmp_path / "storage"))
    maintenance_marker(settings).write_text("Interrupted restore", encoding="utf-8")
    with pytest.raises(RuntimeError, match="restore is incomplete"):
        create_app(settings)


def test_prune_backup_files_only_deletes_matching_prefix(tmp_path: Path) -> None:
    settings = Settings(database_url=f"sqlite+pysqlite:///{tmp_path / 'retention.db'}", seed_demo_data=True, storage_root=str(tmp_path / "storage"))
    with TestClient(create_app(settings)):
        manual = make_backup(settings)
        safety = make_backup(settings, prefix="pre-restore")
        scheduled = [make_backup(settings, prefix="scheduled") for _ in range(3)]
    result = prune_backup_files(settings, prefix="scheduled", keep_count=1)
    names = {backup.filename for backup in list_backup_files(settings)}
    assert len(result.deleted) == 2
    assert manual.filename in names and safety.filename in names
    assert scheduled[-1].filename in names


def test_scheduled_backup_cli_creates_listed_backup_and_prunes_old_automatic_backups(tmp_path: Path) -> None:
    settings = Settings(database_url=f"sqlite+pysqlite:///{tmp_path / 'scheduled.db'}", seed_demo_data=True, storage_root=str(tmp_path / "storage"))
    with TestClient(create_app(settings)):
        results = [run_scheduled_backup(settings=settings, keep_count=2) for _ in range(3)]
    names = sorted(path.name for path in get_backup_root(settings).glob("*.zip"))
    assert results[-1].retention.deleted == [results[0].backup.filename]
    assert names == sorted([results[1].backup.filename, results[2].backup.filename])
