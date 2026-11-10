from contextlib import contextmanager
import os
from pathlib import Path
import shutil

from app.core.config import Settings
from app.core.storage import get_storage_root, resolve_storage_path, safe_storage_segment


@contextmanager
def upload_book_processing_lock(*, settings: Settings, book_id: str):
    """Serialize all processors touching one book, including manual invocations."""
    lock_directory = get_storage_root(settings) / ".locks"
    lock_directory.mkdir(parents=True, exist_ok=True)
    lock_path = lock_directory / f"upload-{safe_storage_segment(book_id)}.lock"
    with lock_path.open("a+b") as lock_file:
        if lock_file.tell() == 0:
            lock_file.write(b"\0")
            lock_file.flush()
        lock_file.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            lock_file.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def replacement_task_directory(*, owner_id: str, book_id: str, task_id: str) -> Path:
    return (
        Path("replacements")
        / safe_storage_segment(owner_id)
        / safe_storage_segment(book_id)
        / safe_storage_segment(task_id)
    )


def replacement_candidate_relative_path(*, owner_id: str, book_id: str, task_id: str, extension: str) -> Path:
    return replacement_task_directory(owner_id=owner_id, book_id=book_id, task_id=task_id) / f"candidate{extension.lower()}"


def replacement_version_relative_path(*, owner_id: str, book_id: str, task_id: str, extension: str) -> Path:
    return Path("originals") / safe_storage_segment(owner_id) / safe_storage_segment(book_id) / "versions" / safe_storage_segment(task_id) / f"original{extension.lower()}"


def cleanup_replacement_task(*, owner_id: str, book_id: str, task_id: str, settings: Settings) -> None:
    task_directory = resolve_storage_path(
        get_storage_root(settings),
        replacement_task_directory(owner_id=owner_id, book_id=book_id, task_id=task_id),
    )
    if task_directory.is_dir():
        shutil.rmtree(task_directory)


def remove_processed_upload_storage(*, owner_id: str, book_id: str, settings: Settings) -> None:
    relative_path = Path("processed") / safe_storage_segment(owner_id) / safe_storage_segment(book_id)
    processed_directory = resolve_storage_path(get_storage_root(settings), relative_path)
    if processed_directory.is_dir():
        shutil.rmtree(processed_directory)
