"""Durable reservations immediately before sending, shared by chapter retries.

A reservation is never refunded: a crash/timeout may have reached the provider.
Existing jobs start counting when this ledger is first created, not retroactively.
"""
import os
from contextlib import closing
from pathlib import Path
import sqlite3
import time
import uuid

from .pilot import TrialError, ensure_storage_parent


def reserve(path: Path, scope: str, limit: int, stage: str, fingerprint: str) -> dict:
    if limit < 1 or not scope:
        raise TrialError('request_budget_unavailable')
    db = None
    try:
        ensure_storage_parent(path)
        # The job directory already exists. Exclusive creation avoids truncating
        # another worker's ledger; root maintenance preserves service ownership.
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            try:
                if hasattr(os, 'fchown') and os.geteuid() == 0:
                    owner = path.parent.stat()
                    os.fchown(fd, owner.st_uid, owner.st_gid)
            finally:
                os.close(fd)
        db = sqlite3.connect(path, timeout=30, isolation_level=None)
        db.execute('PRAGMA synchronous=FULL')
        db.execute('BEGIN IMMEDIATE')
        db.execute('CREATE TABLE IF NOT EXISTS scopes (scope TEXT PRIMARY KEY, cap INTEGER NOT NULL, created_at REAL NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, scope TEXT NOT NULL, stage TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at REAL NOT NULL)')
        db.execute('CREATE INDEX IF NOT EXISTS reservations_scope ON reservations(scope)')
        db.execute('INSERT OR IGNORE INTO scopes VALUES (?, ?, ?)', (scope, limit, time.time()))
        cap = min(limit, db.execute('SELECT cap FROM scopes WHERE scope=?', (scope,)).fetchone()[0])
        db.execute('UPDATE scopes SET cap=? WHERE scope=?', (cap, scope))
        used = db.execute('SELECT count(*) FROM reservations WHERE scope=?', (scope,)).fetchone()[0]
        if used >= cap:
            db.commit()
            raise TrialError('request_budget_exhausted', scope=scope, used=used, limit=cap)
        identity = uuid.uuid4().hex
        db.execute('INSERT INTO reservations VALUES (?, ?, ?, ?, ?)', (identity, scope, stage, fingerprint, time.time()))
        db.commit()
        return {'reservation_id': identity, 'scope': scope, 'used': used + 1, 'limit': cap}
    except (OSError, sqlite3.Error) as error:
        # Never reset an unreadable ledger or guess that a failed write is free.
        raise TrialError('request_budget_unavailable', error_type=type(error).__name__) from error
    finally:
        if db is not None:
            db.close()


def release_unsent(path: Path, scope: str, reservation_id: str) -> None:
    """Undo only a confirmed pre-transport denial by the platform ledger."""
    try:
        with closing(sqlite3.connect(path, timeout=30)) as db:
            with db:
                db.execute('DELETE FROM reservations WHERE id=? AND scope=?', (reservation_id, scope))
    except (OSError, sqlite3.Error) as error:
        raise TrialError('request_budget_unavailable', error_type=type(error).__name__) from error
