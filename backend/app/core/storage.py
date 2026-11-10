from dataclasses import dataclass
from contextlib import contextmanager
from collections.abc import Iterator
from pathlib import Path
from typing import BinaryIO
from uuid import uuid4
import os

from fastapi import UploadFile

from app.core.config import Settings

CHUNK_SIZE = 1024 * 1024


@dataclass(frozen=True)
class StoredFile:
    relative_path: str
    absolute_path: Path
    size: int


class StorageLimitExceededError(Exception):
    pass


@contextmanager
def atomic_file_output(destination: Path) -> Iterator[BinaryIO]:
    """Publish only a complete file; failed writes preserve the previous file."""
    temporary = destination.with_name(f".{destination.name}.{uuid4().hex}.uploading")
    try:
        with temporary.open("xb") as output:
            yield output
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def get_storage_root(settings: Settings) -> Path:
    root = Path(settings.storage_root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


async def save_original_upload(*, book_id: str, owner_id: str, settings: Settings, upload_file: UploadFile) -> StoredFile:
    extension = Path(upload_file.filename or "").suffix.lower()
    destination_relative = Path("originals") / safe_storage_segment(owner_id) / safe_storage_segment(book_id) / f"original{extension}"
    return await write_upload_file(settings=settings, upload_file=upload_file, relative_path=destination_relative)


async def write_upload_file(
    *,
    settings: Settings,
    upload_file: UploadFile,
    relative_path: Path,
    max_size_bytes: int | None = None,
) -> StoredFile:
    root = get_storage_root(settings)
    destination = resolve_storage_path(root, relative_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    size_limit = max_size_bytes if max_size_bytes is not None else settings.max_upload_size_bytes

    total_size = 0
    with atomic_file_output(destination) as output:
        while chunk := await upload_file.read(CHUNK_SIZE):
            total_size += len(chunk)
            if total_size > size_limit:
                raise StorageLimitExceededError(f"Upload exceeds configured size limit: {size_limit} bytes")
            output.write(chunk)

    return StoredFile(relative_path=relative_path.as_posix(), absolute_path=destination, size=total_size)


def write_bytes_file(*, data: bytes, relative_path: Path, settings: Settings) -> StoredFile:
    if len(data) > settings.max_upload_size_bytes:
        raise StorageLimitExceededError(f"File exceeds configured size limit: {settings.max_upload_size_bytes} bytes")

    root = get_storage_root(settings)
    destination = resolve_storage_path(root, relative_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with atomic_file_output(destination) as output:
        output.write(data)
    return StoredFile(relative_path=relative_path.as_posix(), absolute_path=destination, size=len(data))


def resolve_storage_path(root: Path, relative_path: str | Path) -> Path:
    resolved_root = root.resolve()
    resolved_path = (resolved_root / Path(relative_path)).resolve()

    if not resolved_path.is_relative_to(resolved_root):
        raise ValueError(f"Storage path escapes root: {relative_path}")

    return resolved_path


def safe_storage_segment(value: str) -> str:
    safe_value = "".join(char for char in value if char.isalnum() or char in {"-", "_"})
    if not safe_value:
        raise ValueError("Storage path segment cannot be empty")
    return safe_value
