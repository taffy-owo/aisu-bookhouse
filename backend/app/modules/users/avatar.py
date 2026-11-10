from io import BytesIO
import logging
from pathlib import Path
from uuid import uuid4

from PIL import Image, ImageOps

from app.core.config import Settings
from app.core.storage import atomic_file_output, get_storage_root, resolve_storage_path, safe_storage_segment

logger = logging.getLogger(__name__)

AVATAR_SIZE = 320
AVATAR_WEBP_QUALITY = 82
# Reject decompression-bomb images (small file, enormous dimensions) before decoding.
AVATAR_MAX_PIXELS = 40_000_000


def save_optimized_avatar(*, data: bytes, owner_id: str, settings: Settings, timestamp_ms: int) -> str:
    optimized_data = optimize_avatar_bytes(data)
    relative_path = Path("avatars") / safe_storage_segment(owner_id) / f"avatar-{timestamp_ms}-{uuid4().hex}.webp"
    absolute_path = resolve_storage_path(get_storage_root(settings), relative_path)
    absolute_path.parent.mkdir(parents=True, exist_ok=True)
    with atomic_file_output(absolute_path) as output:
        output.write(optimized_data)
    return relative_path.as_posix()


def get_or_create_avatar_derivative(*, source_relative_path: str, user_id: str, settings: Settings) -> Path:
    storage_root = get_storage_root(settings)
    source_path = resolve_storage_path(storage_root, source_relative_path)
    if source_path.suffix.lower() == ".webp":
        return source_path

    derivative_relative_path = Path("avatars") / safe_storage_segment(user_id) / f"{source_path.stem}-{AVATAR_SIZE}.webp"
    derivative_path = resolve_storage_path(storage_root, derivative_relative_path)
    source_mtime = source_path.stat().st_mtime

    if derivative_path.is_file() and derivative_path.stat().st_mtime >= source_mtime:
        return derivative_path

    derivative_path.parent.mkdir(parents=True, exist_ok=True)
    optimized_data = optimize_avatar_bytes(source_path.read_bytes())
    with atomic_file_output(derivative_path) as output:
        output.write(optimized_data)
    return derivative_path


def remove_previous_avatar(previous_avatar: str | None, next_avatar: str, settings: Settings) -> None:
    if not previous_avatar or previous_avatar == next_avatar:
        return

    try:
        storage_root = get_storage_root(settings)
        previous_path = resolve_storage_path(storage_root, previous_avatar)
        next_path = resolve_storage_path(storage_root, next_avatar)
    except ValueError:
        return
    except OSError:
        logger.warning("Could not resolve obsolete avatar for cleanup", exc_info=True)
        return
    if previous_path.parent != next_path.parent:
        logger.warning("Skipping avatar cleanup outside the current user's avatar directory")
        return

    obsolete_paths = [previous_path]
    if previous_path.suffix.lower() != ".webp":
        obsolete_paths.append(previous_path.with_name(f"{previous_path.stem}-{AVATAR_SIZE}.webp"))
    for obsolete_path in obsolete_paths:
        if obsolete_path == next_path:
            continue
        try:
            obsolete_path.unlink(missing_ok=True)
        except OSError:
            logger.warning("Could not remove obsolete avatar %s", obsolete_path, exc_info=True)


def optimize_avatar_bytes(data: bytes) -> bytes:
    with Image.open(BytesIO(data)) as image:
        if image.width * image.height > AVATAR_MAX_PIXELS:
            raise ValueError("图片尺寸过大，请上传更小的图片")
        image = ImageOps.exif_transpose(image)
        image = image.convert("RGB")
        image.thumbnail((AVATAR_SIZE, AVATAR_SIZE), Image.Resampling.LANCZOS)

        canvas = Image.new("RGB", (AVATAR_SIZE, AVATAR_SIZE), sample_edge_color(image))
        x = (AVATAR_SIZE - image.width) // 2
        y = (AVATAR_SIZE - image.height) // 2
        canvas.paste(image, (x, y))

        output = BytesIO()
        canvas.save(output, format="WEBP", quality=AVATAR_WEBP_QUALITY, method=6)
        return output.getvalue()


def sample_edge_color(image: Image.Image) -> tuple[int, int, int]:
    resized = image.resize((1, 1), Image.Resampling.BOX)
    color = resized.getpixel((0, 0))
    if isinstance(color, int):
        return (color, color, color)
    return tuple(color[:3])
