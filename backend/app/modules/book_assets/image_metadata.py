from io import BytesIO
from pathlib import Path
import re
from typing import BinaryIO

from PIL import Image, UnidentifiedImageError

INLINE_ICON_MAX_DIMENSION = 96
INLINE_ICON_MAX_AREA = INLINE_ICON_MAX_DIMENSION * INLINE_ICON_MAX_DIMENSION
INLINE_ICON_HINT_MAX_DIMENSION = 192
INLINE_ICON_THIN_EDGE_MAX = 32
INLINE_DECORATION_MAX_HEIGHT = 48
INLINE_DECORATION_MIN_RATIO = 4

INLINE_ICON_SOURCE_HINTS = (
    "annot",
    "annotation",
    "arrow",
    "badge",
    "bullet",
    "btn",
    "button",
    "caption",
    "decor",
    "decoration",
    "emoji",
    "footnote",
    "gaiji",
    "glyph",
    "icon",
    "inline",
    "line",
    "mark",
    "marker",
    "note",
    "ornament",
    "ruby",
    "symbol",
)

# Publishers often export chapter ornaments at surprisingly large raster
# dimensions. A size-only heuristic cannot reject these without also hiding
# real illustrations, but an exact decoration-style filename is reliable.
INLINE_DECORATION_STEM_RE = re.compile(
    r"^(?:annot(?:ation)?|arrow|badge|bullet|button|caption|decor(?:ation)?|divider|"
    r"emoji|footnote|gaiji|glyph|icon|logo|mark(?:er)?|note|ornament|ruby|separator|symbol)[-_]?\d*$",
    re.IGNORECASE,
)


def read_image_dimensions(data: bytes | BinaryIO) -> tuple[int | None, int | None]:
    try:
        image_data = BytesIO(data) if isinstance(data, bytes) else data
        with Image.open(image_data) as image:
            width, height = image.size
    except (OSError, UnidentifiedImageError, ValueError):
        return None, None

    return width, height


def read_image_file_dimensions(path: Path) -> tuple[int | None, int | None]:
    try:
        with path.open("rb") as image_file:
            return read_image_dimensions(image_file)
    except OSError:
        return None, None


def image_reference_looks_like_inline_icon(
    *,
    display_height: int | None = None,
    display_width: int | None = None,
    pixel_height: int | None = None,
    pixel_width: int | None = None,
    source: str | None = None,
) -> bool:
    if source and source_has_inline_decoration_filename(source):
        return True

    if dimensions_look_like_inline_icon(display_width, display_height):
        return True

    if dimensions_look_like_inline_icon(pixel_width, pixel_height):
        return True

    if source and source_has_inline_icon_hint(source):
        largest_dimension = largest_known_dimension(display_width, display_height, pixel_width, pixel_height)
        return largest_dimension is None or largest_dimension <= INLINE_ICON_HINT_MAX_DIMENSION

    return False


def dimensions_look_like_inline_icon(width: int | None, height: int | None) -> bool:
    if width is None and height is None:
        return False

    if width is None or height is None:
        known_dimension = width or height
        return known_dimension is not None and known_dimension <= INLINE_DECORATION_MAX_HEIGHT

    if width <= 0 or height <= 0:
        return False

    shortest_edge = min(width, height)
    longest_edge = max(width, height)
    if longest_edge <= INLINE_ICON_MAX_DIMENSION:
        return True

    if width * height <= INLINE_ICON_MAX_AREA and shortest_edge <= INLINE_DECORATION_MAX_HEIGHT:
        return True

    if shortest_edge <= INLINE_ICON_THIN_EDGE_MAX and longest_edge <= INLINE_ICON_HINT_MAX_DIMENSION:
        return True

    if height <= INLINE_DECORATION_MAX_HEIGHT and width / max(height, 1) >= INLINE_DECORATION_MIN_RATIO:
        return True

    return False


def source_has_inline_icon_hint(source: str) -> bool:
    normalized_source = source.replace("\\", "/").lower()
    return any(hint in normalized_source for hint in INLINE_ICON_SOURCE_HINTS)


def source_has_inline_decoration_filename(source: str) -> bool:
    normalized_source = source.replace("\\", "/")
    stem = Path(normalized_source.rsplit("/", 1)[-1]).stem
    return INLINE_DECORATION_STEM_RE.fullmatch(stem) is not None


def largest_known_dimension(*dimensions: int | None) -> int | None:
    known_dimensions = [dimension for dimension in dimensions if dimension is not None and dimension > 0]
    return max(known_dimensions) if known_dimensions else None
