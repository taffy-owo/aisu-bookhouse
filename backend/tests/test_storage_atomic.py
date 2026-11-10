import asyncio
from pathlib import Path

import pytest

from app.core.config import Settings
from app.core.storage import StorageLimitExceededError, write_bytes_file, write_upload_file


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [OSError, asyncio.CancelledError])
@pytest.mark.parametrize("existing", [False, True])
async def test_interrupted_upload_does_not_publish_partial_file(tmp_path: Path, error, existing: bool) -> None:
    settings = Settings(storage_root=str(tmp_path))
    target = tmp_path / "original.epub"
    if existing:
        target.write_bytes(b"previous complete book")

    class Upload:
        calls = 0

        async def read(self, _size):
            self.calls += 1
            if self.calls == 1:
                return b"partial new content"
            raise error("interrupted")

    with pytest.raises(error):
        await write_upload_file(settings=settings, upload_file=Upload(), relative_path=Path("original.epub"))
    assert target.exists() == existing
    if existing:
        assert target.read_bytes() == b"previous complete book"
    assert list(tmp_path.glob("*.uploading")) == []


@pytest.mark.asyncio
async def test_rejected_oversized_replacement_preserves_previous_file(tmp_path: Path) -> None:
    target = tmp_path / "original.epub"
    target.write_bytes(b"previous")

    class Upload:
        async def read(self, _size):
            return b"too large"

    with pytest.raises(StorageLimitExceededError):
        await write_upload_file(settings=Settings(storage_root=str(tmp_path)), upload_file=Upload(), relative_path=Path("original.epub"), max_size_bytes=2)
    assert target.read_bytes() == b"previous"
    assert list(tmp_path.glob("*.uploading")) == []


def test_complete_bytes_replace_the_previous_file(tmp_path: Path) -> None:
    settings = Settings(storage_root=str(tmp_path))
    result = write_bytes_file(data=b"complete", relative_path=Path("nested/original.epub"), settings=settings)
    assert result.absolute_path.read_bytes() == b"complete"
    assert result.size == 8
