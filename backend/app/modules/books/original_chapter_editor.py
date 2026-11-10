from html import escape
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
from uuid import uuid4
from urllib.parse import unquote
from xml.etree import ElementTree
from zipfile import BadZipFile, ZIP_STORED, ZipFile

import defusedxml.ElementTree as DefusedElementTree
from fastapi import HTTPException, status

from app.core.config import Settings
from app.core.storage import get_storage_root, resolve_storage_path
from app.modules.book_assets.domain import BookAsset
from app.modules.books.domain import Book
from app.modules.processing.processors.txt_processor import CHAPTER_PATTERN
from app.modules.reader.service import strip_leading_chapter_title


CHAPTER_IMAGE_MARKER_RE = re.compile(r"\[\[AISU_CHAPTER_IMAGE:(\d+)]]")


def original_book_path(book: Book, settings: Settings) -> Path:
    if not book.original_file_path:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="原书文件不存在，无法直接修改")
    try:
        path = resolve_storage_path(get_storage_root(settings), book.original_file_path)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="原书文件路径无效") from error
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="原书文件不存在，无法直接修改")
    return path


def is_original_writeback_supported(book: Book, asset: BookAsset) -> bool:
    if book.reader_type == "text" and (book.file_ext or "").lower() == ".txt":
        return True
    source = asset.metadata.get("source")
    return book.reader_type == "epub" and isinstance(source, str) and bool(source) and source != "manual_append"


def require_original_writeback_supported(book: Book, asset: BookAsset) -> None:
    if is_original_writeback_supported(book, asset):
        return
    if book.reader_type == "epub" and asset.metadata.get("source") == "manual_append":
        detail = "这个章节是旧版手动追加的，尚未写入 EPUB；请替换原书后再编辑"
    elif book.reader_type == "text":
        detail = "MOBI 等二进制电子书不能可靠回写，请使用替换原书功能"
    else:
        detail = "当前格式不支持可靠回写原书，仅 EPUB 和 TXT 正文可以直接修改"
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


def read_raw_editable_content(asset: BookAsset, title: str, settings: Settings) -> str:
    try:
        path = resolve_storage_path(get_storage_root(settings), asset.path)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="章节文件路径无效") from error
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="章节文件不存在")
    try:
        return strip_leading_chapter_title(path.read_text(encoding="utf-8"), title, content_is_body=asset.metadata.get("content_is_body") is True)
    except (OSError, UnicodeError) as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="章节正文读取失败") from error


def stage_original_book_rewrite(
    *,
    all_assets: list[BookAsset],
    book: Book,
    chapter_asset: BookAsset,
    chapter_images: list[BookAsset],
    content: str,
    settings: Settings,
    title: str,
) -> tuple[Path, Path]:
    original_path = original_book_path(book, settings)
    staged_path = original_path.with_name(f".{original_path.name}.{uuid4().hex}.rewrite")
    try:
        if book.reader_type == "epub":
            _stage_epub_rewrite(
                original_path=original_path,
                staged_path=staged_path,
                chapter_asset=chapter_asset,
                chapter_images=chapter_images,
                content=content,
                title=title,
            )
        elif book.reader_type == "text":
            _stage_txt_rewrite(
                staged_path=staged_path,
                all_assets=all_assets,
                chapter_asset=chapter_asset,
                content=content,
                settings=settings,
                title=title,
            )
        else:
            require_original_writeback_supported(book, chapter_asset)
    except HTTPException:
        staged_path.unlink(missing_ok=True)
        raise
    except (BadZipFile, OSError, UnicodeError, ValueError) as error:
        staged_path.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="原书文件重写失败，旧文件未被修改") from error
    return original_path, staged_path


def stage_original_book_delete(
    *,
    all_assets: list[BookAsset],
    book: Book,
    chapter_asset: BookAsset,
    settings: Settings,
) -> tuple[Path, Path]:
    original_path = original_book_path(book, settings)
    staged_path = original_path.with_name(f".{original_path.name}.{uuid4().hex}.delete")
    try:
        if book.reader_type == "epub":
            _stage_epub_delete(
                original_path=original_path,
                staged_path=staged_path,
                chapter_asset=chapter_asset,
            )
        elif book.reader_type == "text":
            _stage_txt_delete(
                staged_path=staged_path,
                all_assets=all_assets,
                chapter_asset=chapter_asset,
                settings=settings,
            )
        else:
            require_original_writeback_supported(book, chapter_asset)
    except HTTPException:
        staged_path.unlink(missing_ok=True)
        raise
    except (BadZipFile, OSError, UnicodeError, ValueError) as error:
        staged_path.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="原书文件删除章节失败，旧文件未被修改") from error
    return original_path, staged_path


def replace_original_with_backup(original_path: Path, staged_path: Path) -> Path:
    backup_path = original_path.with_name(f".{original_path.name}.{uuid4().hex}.backup")
    shutil.copy2(original_path, backup_path)
    try:
        os.replace(staged_path, original_path)
    except Exception:
        backup_path.unlink(missing_ok=True)
        raise
    return backup_path


def restore_original_backup(original_path: Path, backup_path: Path) -> None:
    if backup_path.is_file():
        os.replace(backup_path, original_path)


def _stage_epub_rewrite(
    *,
    original_path: Path,
    staged_path: Path,
    chapter_asset: BookAsset,
    chapter_images: list[BookAsset],
    content: str,
    title: str,
) -> None:
    source = chapter_asset.metadata.get("source")
    if not isinstance(source, str) or not source or source == "manual_append":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="这个 EPUB 章节没有可回写的原文位置")

    with ZipFile(original_path, "r") as source_archive:
        if source not in set(source_archive.namelist()):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="原 EPUB 中找不到当前章节，未执行修改")

        rewritten_document = _rewrite_epub_body(
            document=_decode_epub_document(source_archive.read(source)),
            document_path=source,
            chapter_images=chapter_images,
            content=content,
            title=title,
        ).encode("utf-8")
        infos = source_archive.infolist()
        ordered_infos = [info for info in infos if info.filename == "mimetype"] + [info for info in infos if info.filename != "mimetype"]
        with ZipFile(staged_path, "w") as output_archive:
            for info in ordered_infos:
                data = rewritten_document if info.filename == source else source_archive.read(info.filename)
                if info.filename != source and _is_navigation_document(info.filename):
                    data = _rewrite_navigation_title(data, info.filename, source, title)
                if info.filename == "mimetype":
                    info.compress_type = ZIP_STORED
                output_archive.writestr(info, data)

    with ZipFile(staged_path, "r") as validation_archive:
        if source not in validation_archive.namelist() or validation_archive.testzip() is not None:
            raise ValueError("rewritten EPUB failed validation")


def _stage_epub_delete(*, original_path: Path, staged_path: Path, chapter_asset: BookAsset) -> None:
    source = chapter_asset.metadata.get("source")
    if not isinstance(source, str) or not source or source == "manual_append":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="这个 EPUB 章节没有可回写的原文位置")

    with ZipFile(original_path, "r") as source_archive:
        if source not in set(source_archive.namelist()):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="原 EPUB 中找不到当前章节，未执行删除")
        infos = source_archive.infolist()
        ordered_infos = [info for info in infos if info.filename == "mimetype"] + [info for info in infos if info.filename != "mimetype"]
        with ZipFile(staged_path, "w") as output_archive:
            for info in ordered_infos:
                if info.filename == source:
                    continue
                data = source_archive.read(info.filename)
                if info.filename.lower().endswith(".opf"):
                    data = _remove_epub_package_entry(data, info.filename, source)
                elif _is_navigation_document(info.filename):
                    data = _remove_navigation_entry(data, info.filename, source)
                if info.filename == "mimetype":
                    info.compress_type = ZIP_STORED
                output_archive.writestr(info, data)

    with ZipFile(staged_path, "r") as validation_archive:
        if source in validation_archive.namelist() or validation_archive.testzip() is not None:
            raise ValueError("deleted EPUB failed validation")


def _remove_epub_package_entry(data: bytes, package_path: str, chapter_path: str) -> bytes:
    try:
        root = DefusedElementTree.fromstring(data)
    except (ElementTree.ParseError, ValueError):
        return data
    parents = {child: parent for parent in root.iter() for child in parent}
    removed_ids: set[str] = set()
    changed = False
    for element in list(root.iter()):
        if _local_name(element.tag) != "item":
            continue
        href = element.attrib.get("href")
        if href and _resolve_navigation_href(package_path, href) == chapter_path:
            item_id = element.attrib.get("id")
            if item_id:
                removed_ids.add(item_id)
            parent = parents.get(element)
            if parent is not None:
                parent.remove(element)
                changed = True
    for element in list(root.iter()):
        local_name = _local_name(element.tag)
        href = element.attrib.get("href")
        should_remove = (
            local_name == "itemref" and element.attrib.get("idref") in removed_ids
        ) or (
            local_name == "reference" and href and _resolve_navigation_href(package_path, href) == chapter_path
        )
        if should_remove:
            parent = parents.get(element)
            if parent is not None:
                parent.remove(element)
                changed = True
    if not changed:
        raise ValueError("chapter is missing from EPUB package manifest")
    had_xml_declaration = data.lstrip().startswith(b"<?xml")
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=had_xml_declaration)


def _remove_navigation_entry(data: bytes, navigation_path: str, chapter_path: str) -> bytes:
    try:
        root = DefusedElementTree.fromstring(data)
    except (ElementTree.ParseError, ValueError):
        return data
    parents = {child: parent for parent in root.iter() for child in parent}
    removals: set[ElementTree.Element] = set()
    for element in root.iter():
        local_name = _local_name(element.tag)
        if local_name == "navPoint":
            content_element = next((child for child in element.iter() if _local_name(child.tag) == "content"), None)
            href = content_element.attrib.get("src") if content_element is not None else None
            if href and _resolve_navigation_href(navigation_path, href) == chapter_path:
                removals.add(element)
        elif local_name == "a":
            href = element.attrib.get("href")
            if href and _resolve_navigation_href(navigation_path, href) == chapter_path:
                candidate = element
                while parents.get(candidate) is not None and _local_name(parents[candidate].tag) not in {"li", "navPoint"}:
                    candidate = parents[candidate]
                removals.add(parents.get(candidate, candidate) if _local_name(parents.get(candidate, candidate).tag) in {"li", "navPoint"} else candidate)
    changed = False
    for element in removals:
        parent = parents.get(element)
        if parent is not None and element in list(parent):
            parent.remove(element)
            changed = True
    if not changed:
        return data
    had_xml_declaration = data.lstrip().startswith(b"<?xml")
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=had_xml_declaration)


def _rewrite_epub_body(
    *,
    document: str,
    document_path: str,
    chapter_images: list[BookAsset],
    content: str,
    title: str,
) -> str:
    body_match = re.search(r"(?is)(<body\b[^>]*>)(.*?)(</body\s*>)", document)
    if not body_match:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="当前 EPUB 章节结构异常，未执行修改")

    marker_to_image_path: dict[int, str] = {}
    for image in chapter_images:
        image_source = image.metadata.get("source")
        image_document = image.metadata.get("document")
        if image_document == document_path and isinstance(image.index, int) and isinstance(image_source, str):
            marker_to_image_path[image.index] = image_source

    marker_indexes = [int(value) for value in CHAPTER_IMAGE_MARKER_RE.findall(content)]
    if missing_indexes := sorted(set(marker_indexes) - set(marker_to_image_path)):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"正文中包含无法识别的插画占位符：{', '.join(map(str, missing_indexes))}",
        )

    rendered_blocks = [f'<h1 data-aisu-chapter-title="true">{escape(title)}</h1>']
    for paragraph in _split_content_blocks(content):
        marker = CHAPTER_IMAGE_MARKER_RE.fullmatch(paragraph.strip())
        if marker:
            image_path = marker_to_image_path[int(marker.group(1))]
            relative_src = posixpath.relpath(image_path, start=str(PurePosixPath(document_path).parent) or ".")
            rendered_blocks.append(
                '<div class="aisu-chapter-image"><img alt="插图" '
                f'src="{escape(relative_src, quote=True)}" style="max-width:100%;height:auto" /></div>'
            )
        else:
            rendered_blocks.append(f"<p>{escape(paragraph).replace(chr(10), '<br />')}</p>")

    replacement = f"{body_match.group(1)}\n    " + "\n    ".join(rendered_blocks) + f"\n  {body_match.group(3)}"
    rewritten = document[: body_match.start()] + replacement + document[body_match.end() :]
    return re.sub(r"(?i)(<\?xml[^>]*encoding=[\"'])[^\"']+", r"\1UTF-8", rewritten, count=1)


def _is_navigation_document(path: str) -> bool:
    lower_path = path.lower()
    file_name = PurePosixPath(lower_path).name
    return lower_path.endswith(".ncx") or (
        lower_path.endswith((".xhtml", ".html", ".htm")) and any(label in file_name for label in ("nav", "toc", "contents"))
    )


def _rewrite_navigation_title(data: bytes, navigation_path: str, chapter_path: str, title: str) -> bytes:
    try:
        root = DefusedElementTree.fromstring(data)
    except (ElementTree.ParseError, ValueError):
        return data

    changed = False
    for element in root.iter():
        if _local_name(element.tag) == "navPoint":
            content_element = next((child for child in element.iter() if _local_name(child.tag) == "content"), None)
            source = content_element.attrib.get("src") if content_element is not None else None
            if source and _resolve_navigation_href(navigation_path, source) == chapter_path:
                label_element = next((child for child in element.iter() if _local_name(child.tag) == "text"), None)
                if label_element is not None:
                    _replace_element_text(label_element, title)
                    changed = True
        elif _local_name(element.tag) == "a":
            href = element.attrib.get("href")
            if href and _resolve_navigation_href(navigation_path, href) == chapter_path:
                _replace_element_text(element, title)
                changed = True

    if not changed:
        return data
    had_xml_declaration = data.lstrip().startswith(b"<?xml")
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=had_xml_declaration)


def _resolve_navigation_href(navigation_path: str, href: str) -> str:
    href_path = unquote(href.split("#", 1)[0]).replace("\\", "/")
    if href_path.startswith("/"):
        return posixpath.normpath(href_path.lstrip("/"))
    return posixpath.normpath(posixpath.join(str(PurePosixPath(navigation_path).parent), href_path))


def _replace_element_text(element: ElementTree.Element, text: str) -> None:
    for child in list(element):
        element.remove(child)
    element.text = text


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _stage_txt_rewrite(
    *,
    staged_path: Path,
    all_assets: list[BookAsset],
    chapter_asset: BookAsset,
    content: str,
    settings: Settings,
    title: str,
) -> None:
    # Rebuild from chapter boundaries rather than replacing a body substring.
    # Repeated renames otherwise leave an old heading behind, and arbitrary
    # titles need a parseable prefix to survive a later import or reprocess.
    rewritten = _reconstruct_txt_assets(all_assets, chapter_asset, content, settings, title)
    staged_path.write_text(rewritten.rstrip() + "\n", encoding="utf-8", newline="\n")


def _stage_txt_delete(
    *,
    staged_path: Path,
    all_assets: list[BookAsset],
    chapter_asset: BookAsset,
    settings: Settings,
) -> None:
    chapters: list[str] = []
    remaining_assets = [asset for asset in all_assets if asset.id != chapter_asset.id]
    for index, asset in enumerate(remaining_assets, start=1):
        title = _asset_title(asset, index)
        asset_path = resolve_storage_path(get_storage_root(settings), asset.path)
        body = strip_leading_chapter_title(asset_path.read_text(encoding="utf-8"), title, content_is_body=asset.metadata.get("content_is_body") is True)
        parseable_title = title if CHAPTER_PATTERN.fullmatch(title) else f"第{index}章 {title}"
        chapters.append(f"{parseable_title}\n\n{body}".strip())
    staged_path.write_text("\n\n".join(chapters).rstrip() + "\n", encoding="utf-8", newline="\n")


def _reconstruct_txt_assets(
    all_assets: list[BookAsset],
    chapter_asset: BookAsset,
    content: str,
    settings: Settings,
    title: str,
) -> str:
    chapters: list[str] = []
    for index, asset in enumerate(all_assets, start=1):
        asset_title = title if asset.id == chapter_asset.id else _asset_title(asset, index)
        if asset.id == chapter_asset.id:
            asset_body = content
        else:
            asset_path = resolve_storage_path(get_storage_root(settings), asset.path)
            asset_body = strip_leading_chapter_title(asset_path.read_text(encoding="utf-8"), asset_title, content_is_body=asset.metadata.get("content_is_body") is True)
        parseable_title = asset_title if CHAPTER_PATTERN.fullmatch(asset_title) else f"第{index}章 {asset_title}"
        chapters.append(f"{parseable_title}\n\n{asset_body}".strip())
    return "\n\n".join(chapters)


def _asset_title(asset: BookAsset, fallback_index: int) -> str:
    title = asset.metadata.get("title")
    return title.strip() if isinstance(title, str) and title.strip() else f"第 {fallback_index} 章"


def _split_content_blocks(content: str) -> list[str]:
    return [block.strip() for block in re.split(r"\n{2,}", content) if block.strip()]


def _decode_epub_document(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")
