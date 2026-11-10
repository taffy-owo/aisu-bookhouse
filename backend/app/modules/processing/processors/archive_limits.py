from zipfile import ZipFile, ZipInfo

from app.core.config import Settings
from app.core.storage import StorageLimitExceededError


class ArchiveProcessingBudget:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._asset_count = 0
        self._processed_size = 0
        self._counted_members: set[str] = set()

    def ensure_archive_entry_count(self, archive: ZipFile) -> None:
        entry_count = len(archive.infolist())
        if entry_count > self._settings.max_archive_entries:
            raise StorageLimitExceededError(f"Archive contains too many entries: {entry_count}")

    def reserve_asset(self) -> None:
        self._asset_count += 1
        if self._asset_count > self._settings.max_processed_assets_per_book:
            raise StorageLimitExceededError(f"Book produces too many reader assets: {self._asset_count}")

    def reserve_member(self, member: ZipInfo | str, archive: ZipFile | None = None) -> ZipInfo:
        info = archive.getinfo(member) if isinstance(member, str) else member
        if info.file_size > self._settings.max_archive_member_size_bytes:
            raise StorageLimitExceededError(f"Archive member exceeds configured size limit: {info.filename}")

        # A single member can legitimately be read more than once (e.g. an EPUB document
        # scanned first for text and again for inline images); only count it toward the
        # cumulative budget the first time so repeated reads don't trip a false positive.
        if info.filename not in self._counted_members:
            self._counted_members.add(info.filename)
            self._processed_size += info.file_size
            if self._processed_size > self._settings.max_processed_size_bytes:
                raise StorageLimitExceededError("Archive extraction exceeds configured size limit")

        return info


def read_limited_member(archive: ZipFile, name: str, budget: ArchiveProcessingBudget) -> bytes:
    budget.reserve_member(name, archive)
    return archive.read(name)
