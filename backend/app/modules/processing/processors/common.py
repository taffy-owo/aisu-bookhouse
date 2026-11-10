from pathlib import PurePosixPath
import re

IMAGE_EXTENSIONS = {".avif", ".bmp", ".gif", ".jpeg", ".jfif", ".jpg", ".png", ".webp"}


def get_extension(path: str) -> str:
    return PurePosixPath(path).suffix.lower()


def is_supported_image(path: str) -> bool:
    return get_extension(path) in IMAGE_EXTENSIONS


def natural_sort_key(value: str) -> list[int | str]:
    parts = re.split(r"(\d+)", value)
    return [int(part) if part.isdigit() else part.lower() for part in parts]
