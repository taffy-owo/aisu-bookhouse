from pathlib import Path
from dataclasses import asdict
from datetime import datetime
import json
import sqlite3

from alembic import command
from alembic.config import Config
from app.modules.books.factory import create_uploaded_book


def test_existing_database_upgrades_through_sessions_and_reading_indexes(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("AISU_DATABASE_URL", raising=False)
    backend_root = Path(__file__).resolve().parents[1]
    database = tmp_path / "upgrade.sqlite3"
    config = Config(str(backend_root / "alembic.ini"))
    config.set_main_option("script_location", str(backend_root / "alembic"))
    config.set_main_option("sqlalchemy.url", f"sqlite+pysqlite:///{database.as_posix()}")

    command.upgrade(config, "20260908_0040")
    command.upgrade(config, "head")

    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "20261027_0055"
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"oauth_accounts", "oauth_login_tickets"}.issubset(tables)
        assert connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_sessions'").fetchone()
        indexes = {row[1] for row in connection.execute("PRAGMA index_list(books)")}
        assert {"ix_books_owner_created_id", "ix_books_owner_favorite_updated"} <= indexes
        reading_indexes = {row[1] for row in connection.execute("PRAGMA index_list(reading_activity)")}
        assert "ix_reading_activity_user_book" in reading_indexes
        comment_indexes = {row[1] for row in connection.execute("PRAGMA index_list(public_comments)")}
        assert "ix_public_comments_target_created" in comment_indexes
        channel_indexes = {row[1] for row in connection.execute("PRAGMA index_list(ai_channels)")}
        assert "uq_ai_channels_provider_default" in channel_indexes


def test_provider_channel_migration_adopts_only_unambiguous_matching_defaults(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("AISU_DATABASE_URL", raising=False)
    backend_root = Path(__file__).resolve().parents[1]
    database = tmp_path / "provider-link.sqlite3"
    config = Config(str(backend_root / "alembic.ini"))
    config.set_main_option("script_location", str(backend_root / "alembic"))
    config.set_main_option("sqlalchemy.url", f"sqlite+pysqlite:///{database.as_posix()}")
    command.upgrade(config, "20261019_0052")
    with sqlite3.connect(database) as connection:
        for index, user in enumerate(['single', 'ambiguous', 'custom'], 1):
            connection.execute("""INSERT INTO users (id, account_number, email, password_hash, nickname, role, status,
                ai_translation_concurrency, ai_provider_base_url, ai_provider_api_key_encrypted, created_at, updated_at)
                VALUES (?, ?, ?, 'test', 'test', 'user', 'active', 2, 'https://provider.example.com/v1', 'encrypted-test', '2026-10-01', '2026-10-01')""", (user, index, user + '@example.com'))
        for channel, user, name, key in [('adopt', 'single', '默认渠道', 'encrypted-test'),
                ('other', 'single', 'Independent', 'encrypted-test'), ('wrong-key', 'single', '默认渠道', 'different-key'),
                ('ambiguous-1', 'ambiguous', '默认渠道', 'encrypted-test'), ('ambiguous-2', 'ambiguous', '默认渠道', 'encrypted-test'),
                ('renamed', 'custom', 'Renamed', 'encrypted-test')]:
            connection.execute("""INSERT INTO ai_channels (id,user_id,name,base_url,api_key_encrypted,enabled,sort_order,created_at,updated_at)
                VALUES (?,?,?,'https://provider.example.com/v1',?,1,0,'2026-10-01','2026-10-01')""", (channel, user, name, key))
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        flags = dict(connection.execute("SELECT id,is_provider_default FROM ai_channels"))
        assert flags == {'adopt': 1, 'other': 0, 'wrong-key': 0, 'ambiguous-1': 0, 'ambiguous-2': 0, 'renamed': 0}
        assert connection.execute("SELECT COUNT(*) FROM ai_channels").fetchone()[0] == 6
    command.downgrade(config, "20261019_0052")
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        assert dict(connection.execute("SELECT id,is_provider_default FROM ai_channels")) == flags


def test_language_mode_migration_preserves_existing_book_data(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("AISU_DATABASE_URL", raising=False)
    backend_root = Path(__file__).resolve().parents[1]
    database = tmp_path / "language-mode.sqlite3"
    config = Config(str(backend_root / "alembic.ini"))
    config.set_main_option("script_location", str(backend_root / "alembic"))
    config.set_main_option("sqlalchemy.url", f"sqlite+pysqlite:///{database.as_posix()}")
    command.upgrade(config, "20261024_0053")
    with sqlite3.connect(database) as connection:
        connection.execute("""INSERT INTO users (id, account_number, email, password_hash, nickname, role, status,
            ai_translation_concurrency, created_at, updated_at) VALUES ('legacy-owner',1,'legacy@example.test',
            'test','Legacy','user','active',2,'2026-10-01','2026-10-01')""")
        columns = [row[1] for row in connection.execute("PRAGMA table_info(books)")]
        for language in ("zh", "und"):
            book = create_uploaded_book(author="Legacy author", book_id="legacy-" + language, file_label="TXT", kind="novel",
                owner_id="legacy-owner", reader_type="text", tags=("Saved tag",), title="Saved title").with_changes(language=language, status="ready")
            values = asdict(book)
            payload = {key: value.isoformat() if isinstance(value, datetime) else json.dumps(value) if isinstance(value, tuple) else value
                for key, value in values.items() if key in columns}
            connection.execute(f"INSERT INTO books ({','.join(payload)}) VALUES ({','.join('?' for _ in payload)})", tuple(payload.values()))
        original = connection.execute("SELECT * FROM books ORDER BY id").fetchall()
    for _ in range(2):
        command.upgrade(config, "20261025_0054")
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT language_mode FROM books").fetchall() == [(None,), (None,)]
            assert connection.execute(f"SELECT {','.join(columns)} FROM books ORDER BY id").fetchall() == original
        command.downgrade(config, "20261024_0053")
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT * FROM books ORDER BY id").fetchall() == original


def test_reader_mark_position_migration_preserves_note_content(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("AISU_DATABASE_URL", raising=False)
    root = Path(__file__).resolve().parents[1]
    database = tmp_path / "reader-marks.sqlite3"
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    config.set_main_option("sqlalchemy.url", f"sqlite+pysqlite:///{database.as_posix()}")
    command.upgrade(config, "20261025_0054")
    with sqlite3.connect(database) as connection:
        connection.execute("""INSERT INTO users (id, account_number, email, password_hash, nickname, role, status,
            ai_translation_concurrency, created_at, updated_at) VALUES ('note-owner',1,'notes@example.test',
            'test','Notes','user','active',2,'2026-10-01','2026-10-01')""")
        columns = [row[1] for row in connection.execute("PRAGMA table_info(books)")]
        book = create_uploaded_book(author="Author", book_id="note-book", file_label="EPUB", kind="novel", owner_id="note-owner",
                                    reader_type="epub", tags=(), title="Book")
        payload = {key: value.isoformat() if isinstance(value, datetime) else json.dumps(value) if isinstance(value, tuple) else value
                   for key, value in asdict(book).items() if key in columns}
        connection.execute(f"INSERT INTO books ({','.join(payload)}) VALUES ({','.join('?' for _ in payload)})", tuple(payload.values()))
        connection.execute("""INSERT INTO reader_marks (id,user_id,book_id,reader_type,kind,note,label,chapter_index,progress_percent,created_at,updated_at)
            VALUES ('note','note-owner','note-book','epub','note','保留全文和原始日期。','手动标题',3,25,'2026-10-01','2026-10-02')""")
        old_columns = [row[1] for row in connection.execute("PRAGMA table_info(reader_marks)")]
        original = connection.execute("SELECT * FROM reader_marks").fetchall()
    for _ in range(2):
        command.upgrade(config, "20261027_0055")
        with sqlite3.connect(database) as connection:
            assert connection.execute(f"SELECT {','.join(old_columns)} FROM reader_marks").fetchall() == original
            assert connection.execute("SELECT position_key,position_valid FROM reader_marks").fetchall() == [(None, 1)]
        command.downgrade(config, "20261025_0054")
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT * FROM reader_marks").fetchall() == original
