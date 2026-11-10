"""Inspect or repair missing TXT lengths while the site's writers are stopped.

This is an offline maintenance command, not an API or startup migration. The
operator must hold the maintenance lock and stop both web and upload workers
before applying changes. Chapter bytes, IDs, book state and progress are kept.
"""
from __future__ import annotations

import argparse
from collections.abc import Callable
from contextlib import closing
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sqlite3
import sys
import tempfile


MAX_CHAPTER_BYTES = 64 * 1024 * 1024


@dataclass(frozen=True)
class TextLengthEntry:
    asset_id: str
    book_id: str
    path: str
    original_metadata: str
    text_length: int
    file_bytes: int
    sha256: str


@dataclass(frozen=True)
class TextLengthRepair:
    applied: bool
    entries: tuple[TextLengthEntry, ...]

    def summary(self) -> dict[str, object]:
        return {
            "status": "applied" if self.applied else "inspected",
            "asset_count": len(self.entries),
            "book_count": len({entry.book_id for entry in self.entries}),
            "character_count": sum(entry.text_length for entry in self.entries),
        }


def _read_chapter(storage_root: Path, relative: str) -> bytes:
    # Stored paths use POSIX separators on both Windows and Linux. Reject
    # alternate separators and drive prefixes instead of silently normalizing.
    parts = PurePosixPath(relative)
    if not relative or parts.is_absolute() or ".." in parts.parts or "\\" in relative or ":" in relative:
        raise ValueError("Chapter path is not a relative storage path")
    target = storage_root
    for part in parts.parts:
        target = target / part
        if target.is_symlink():
            raise ValueError("Chapter path contains a symbolic link")
    resolved = target.resolve(strict=True)
    if not resolved.is_relative_to(storage_root) or not resolved.is_file():
        raise ValueError("Chapter is not a regular file inside storage")
    if resolved.stat().st_size > MAX_CHAPTER_BYTES:
        raise ValueError("Chapter exceeds the maintenance size limit")
    with resolved.open("rb") as stream:
        data = stream.read(MAX_CHAPTER_BYTES + 1)
    if len(data) > MAX_CHAPTER_BYTES:
        raise ValueError("Chapter grew beyond the maintenance size limit")
    return data


def repair_text_lengths(
    connection: sqlite3.Connection,
    storage_root: Path,
    *,
    apply: bool = False,
    on_plan: Callable[[TextLengthRepair], None] | None = None,
) -> TextLengthRepair:
    """Validate the complete plan, save its receipt, then commit it atomically.

    Only active TXT books with an absent length key are eligible. Existing
    lengths, explicit nulls, EPUBs and deleted books remain untouched. Repeated
    application finds no eligible assets. A failed file, receipt or conditional
    write rolls back the entire transaction.
    """
    if connection.in_transaction:
        raise ValueError("Maintenance requires an independent transaction")
    root = Path(storage_root).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Storage root is not a directory")
    connection.execute("BEGIN IMMEDIATE" if apply else "BEGIN")
    try:
        rows = connection.execute("""
            SELECT a.id, a.book_id, a.path, a.metadata
            FROM book_assets AS a JOIN books AS b ON b.id = a.book_id
            WHERE b.status != 'deleted' AND b.deleted_at IS NULL AND lower(b.file_ext) = '.txt'
              AND a.asset_type = 'text_chapter'
              AND json_type(a.metadata, '$.text_length') IS NULL
            ORDER BY a.book_id, a.id
        """).fetchall()
        entries = []
        for asset_id, book_id, path, original in rows:
            metadata = json.loads(original)
            if not isinstance(metadata, dict) or "text_length" in metadata:
                raise ValueError("Chapter metadata is not an eligible object")
            data = _read_chapter(root, path)
            entries.append(TextLengthEntry(
                asset_id, book_id, path, original, len(data.decode("utf-8")),
                len(data), hashlib.sha256(data).hexdigest(),
            ))
        plan = TextLengthRepair(False, tuple(entries))
        if on_plan:
            on_plan(plan)
        if apply:
            # The receipt is durable before any write. Check files again after
            # that callback so a changed file cannot be paired with old lengths.
            for entry in entries:
                data = _read_chapter(root, entry.path)
                if len(data) != entry.file_bytes or hashlib.sha256(data).hexdigest() != entry.sha256:
                    raise ValueError("Chapter changed after the repair plan")
            for entry in entries:
                cursor = connection.execute("""
                    UPDATE book_assets
                    SET metadata = json_set(metadata, '$.text_length', ?)
                    WHERE id = ? AND book_id = ? AND path = ? AND metadata = ?
                      AND asset_type = 'text_chapter'
                      AND json_type(metadata, '$.text_length') IS NULL
                """, (entry.text_length, entry.asset_id, entry.book_id, entry.path, entry.original_metadata))
                if cursor.rowcount != 1:
                    raise ValueError("Chapter metadata changed after the repair plan")
            connection.commit()
        else:
            connection.rollback()
        return TextLengthRepair(apply, tuple(entries))
    except BaseException:
        connection.rollback()
        raise


def _write_receipt(path: Path, payload: dict[str, object], *, replace: bool = False) -> None:
    """Use exclusive creation for the original plan and atomic completion."""
    encoded = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    if not replace:
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        _sync_directory(path.parent)
        return
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        _sync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _sync_directory(directory: Path) -> None:
    if os.name == "posix":
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--storage-root", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--apply", action="store_true", help="Apply offline, with the maintenance lock and writers stopped")
    args = parser.parse_args(argv)
    database = args.database.resolve(strict=True)
    receipt = args.receipt.absolute()
    if receipt.exists():
        parser.error("Use a new receipt path; previous repair evidence is never overwritten")
    recorded: dict[str, object] | None = None

    def save_plan(plan: TextLengthRepair) -> None:
        nonlocal recorded
        recorded = {
            **plan.summary(), "status": "planned" if args.apply else "inspected",
            "database": str(database), "storage_root": str(args.storage_root.resolve(strict=True)),
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "entries": [asdict(entry) for entry in plan.entries],
        }
        _write_receipt(receipt, recorded)

    # URI mode avoids creating a new, empty database after a path mistake.
    mode = "rw" if args.apply else "ro"
    with closing(sqlite3.connect(database.as_uri() + "?mode=" + mode, uri=True, timeout=30)) as connection:
        result = repair_text_lengths(connection, args.storage_root, apply=args.apply, on_plan=save_plan)
    if args.apply:
        assert recorded is not None
        # If completion writing fails after COMMIT, the durable planned receipt
        # still contains every original value. Rerunning is idempotent.
        _write_receipt(receipt, {**recorded, **result.summary(), "completed_at_utc": datetime.now(timezone.utc).isoformat()}, replace=True)
    print(json.dumps(result.summary(), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
