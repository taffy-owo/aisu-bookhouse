"""Offline, atomic rotation of user-supplied provider credentials.

Run with the app and worker stopped. The old and new secrets are read from
environment variables so neither appears in the process command line.
"""

from __future__ import annotations

import argparse
import json
import os

from cryptography.fernet import InvalidToken
from sqlalchemy import select

from app.core.config import Settings, get_settings
from app.core.database import create_database_engine, create_session_factory
from app.core.maintenance import maintenance_lock
from app.modules.admin.backup_cli import require_writers_stopped
from app.modules.ai_channels.models import AiChannelRecord
from app.modules.translations.models import WholeBookTranslationJobRecord
from app.modules.users.ai_settings import credential_cipher
from app.modules.users.models import UserRecord


CREDENTIAL_SOURCES = (
    ("users", UserRecord, ("ai_provider_api_key_encrypted", "audiobook_provider_api_key_encrypted")),
    ("ai_channels", AiChannelRecord, ("api_key_encrypted",)),
    ("whole_book_translation_jobs", WholeBookTranslationJobRecord, ("provider_api_key_encrypted",)),
)


def _scan_credentials(session, old_secret: str) -> tuple[dict[str, dict[str, object]], list[tuple[object, str, bytes]]]:
    cipher = credential_cipher(old_secret)
    report: dict[str, dict[str, object]] = {}
    plaintext: list[tuple[object, str, bytes]] = []
    for table, model, columns in CREDENTIAL_SOURCES:
        stats: dict[str, object] = {"pending": 0, "verified": 0, "failures": []}
        failures: list[str] = stats["failures"]  # type: ignore[assignment]
        report[table] = stats
        for record in session.scalars(select(model)).all():
            for column in columns:
                encrypted = getattr(record, column)
                if not encrypted:
                    continue
                stats["pending"] = int(stats["pending"]) + 1
                try:
                    value = cipher.decrypt(encrypted.encode("ascii"))
                    value.decode("utf-8")
                except (InvalidToken, UnicodeError, ValueError):
                    failures.append(f"{record.id}:{column}")
                    continue
                stats["verified"] = int(stats["verified"]) + 1
                plaintext.append((record, column, value))
    return report, plaintext


def inspect_stored_credentials(*, old_secret: str, settings: Settings) -> dict[str, dict[str, object]]:
    """Read-only count and validation; identifiers only, never plaintext keys."""
    engine = create_database_engine(settings)
    try:
        with create_session_factory(engine)() as session:
            report, _ = _scan_credentials(session, old_secret)
            return report
    finally:
        engine.dispose()


def rotate_stored_credentials(*, old_secret: str, new_secret: str, settings: Settings) -> int:
    with maintenance_lock(settings):
        return _rotate_stored_credentials_locked(old_secret=old_secret, new_secret=new_secret, settings=settings)


def _rotate_stored_credentials_locked(*, old_secret: str, new_secret: str, settings: Settings) -> int:
    require_writers_stopped(settings)
    if old_secret == new_secret:
        raise ValueError("The new credential key must differ from the old key")
    new_cipher = credential_cipher(new_secret)
    engine = create_database_engine(settings)
    try:
        with create_session_factory(engine)() as session:
            # Verify every value before updating any record. A wrong old key or
            # corrupt credential must leave the entire database untouched.
            report, plaintext = _scan_credentials(session, old_secret)
            failures = [f"{table}:{item}" for table, stats in report.items() for item in stats["failures"]]
            if failures:
                raise ValueError(f"Cannot decrypt {', '.join(failures)}; no credentials were changed")
            for record, column, value in plaintext:
                setattr(record, column, new_cipher.encrypt(value).decode("ascii"))
            session.commit()
            return len(plaintext)
    finally:
        engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="Rotate stored AI and audiobook credentials offline")
    parser.add_argument("--old-key-env", required=True, help="Environment variable containing the current key")
    parser.add_argument("--new-key-env", default="AISU_ENCRYPTION_KEY", help="Environment variable containing the replacement key")
    parser.add_argument("--preflight", action="store_true", help="Only verify and count stored credentials")
    parser.add_argument("--confirm", default="", help="Must be ROTATE for a write")
    args = parser.parse_args()
    old_secret = os.environ.get(args.old_key_env, "")
    if not old_secret:
        parser.error("The old key environment variable must contain a secret")
    if args.preflight:
        report = inspect_stored_credentials(old_secret=old_secret, settings=get_settings())
        print(json.dumps(report, ensure_ascii=False, sort_keys=True))
        if any(stats["failures"] for stats in report.values()):
            raise SystemExit(2)
        return
    if args.confirm != "ROTATE":
        parser.error("--confirm ROTATE is required")
    new_secret = os.environ.get(args.new_key_env, "")
    if not new_secret:
        parser.error("The new key environment variable must contain a secret")
    count = rotate_stored_credentials(old_secret=old_secret, new_secret=new_secret, settings=get_settings())
    print(f"Rotated {count} encrypted credentials")


if __name__ == "__main__":
    main()
