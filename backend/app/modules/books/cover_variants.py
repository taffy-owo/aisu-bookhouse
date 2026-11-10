"""On-demand, versioned cover thumbnails outside the backed-up book storage."""

from hashlib import sha256
from io import BytesIO
import os
from pathlib import Path
from uuid import uuid4

from PIL import Image, ImageOps

from app.core.config import Settings
from app.core.storage import get_storage_root


COVER_SIZES = {
    "small": (160, 240),
    "medium": (400, 600),
    "large": (800, 1200),
}


def cover_variant_path(source: Path, size: str, settings: Settings) -> Path:
    width, height = COVER_SIZES[size]
    stat = source.stat()
    revision = sha256(f"{source.resolve()}:{stat.st_size}:{stat.st_mtime_ns}".encode()).hexdigest()
    target = get_storage_root(settings).parent / "cover-cache" / f"{revision}-{size}.webp"
    if target.is_file():
        return target

    with Image.open(source) as opened:
        if opened.width * opened.height > 40_000_000:
            raise ValueError("Cover exceeds the supported pixel limit")
        image = ImageOps.exif_transpose(opened).convert("RGB")
        image.thumbnail((width, height), Image.Resampling.LANCZOS)
        output = BytesIO()
        image.save(output, format="WEBP", quality=82, method=5)

    target.parent.mkdir(parents=True, exist_ok=True)
    staged = target.with_name(f".{target.name}.{uuid4().hex}.tmp")
    try:
        staged.write_bytes(output.getvalue())
        os.replace(staged, target)
    finally:
        staged.unlink(missing_ok=True)
    return target
