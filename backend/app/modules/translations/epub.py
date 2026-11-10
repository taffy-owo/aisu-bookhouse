from __future__ import annotations

from datetime import datetime, timezone

from html import escape
from io import BytesIO
import posixpath
from uuid import uuid4
from urllib.parse import unquote
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile
from xml.etree import ElementTree as ET
import defusedxml.ElementTree as SafeElementTree
from defusedxml.common import DefusedXmlException
from app.modules.processing.processors.epub_source_identity import epub_source_identity_tags, extract_epub_source_identity
from app.modules.books.source_identity import source_url_identity


CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container"
OPF_NS = "http://www.idpf.org/2007/opf"
XHTML_NS = "http://www.w3.org/1999/xhtml"
EPUB_NS = "http://www.idpf.org/2007/ops"
NCX_NS = "http://www.daisy.org/z3986/2005/ncx/"


def _source_keys(chapter):
    url = source_url_identity(chapter.get('source_url') or chapter.get('source_episode_url'))
    source_id = chapter.get('source_id') or chapter.get('external_source_id')
    return ({('url', url)} if url else set()) | ({('id', source_id)} if isinstance(source_id, str) and source_id else set())


def _claim_source_chapters(chapters, seen):
    for chapter in chapters:
        keys = _source_keys(chapter)
        if keys.intersection(seen):
            raise ValueError('Source chapter already exists in EPUB')
        seen.update(keys)


def _read_source_identity(archive, item):
    # Only the document head carries provenance. Bound the scan even for an
    # externally supplied legacy EPUB with an oversized compressed member.
    with archive.open(item) as document:
        head = document.read(1024 * 1024)
    root = None
    try:
        for event, element in SafeElementTree.iterparse(BytesIO(head), events=('start', 'end')):
            if root is None:
                root = element
            if event == 'end' and element.tag == f'{{{XHTML_NS}}}head':
                return extract_epub_source_identity(ET.tostring(root, encoding='utf-8'))
    except (ET.ParseError, DefusedXmlException):
        pass
    return {}


def build_translation_epub(
    *,
    title: str,
    author: str,
    description: str,
    source_url: str,
    chapters: list[dict[str, object]],
    tags: list[str] | None = None,
) -> bytes:
    _claim_source_chapters(chapters, set())
    book_uuid = str(uuid4())
    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip", compress_type=ZIP_STORED)
        archive.writestr("META-INF/container.xml", _container_xml(), compress_type=ZIP_DEFLATED)
        archive.writestr("OEBPS/style.css", _stylesheet(), compress_type=ZIP_DEFLATED)
        manifest_items: list[str] = []
        spine_items: list[str] = []
        nav_items: list[str] = []
        ncx_items: list[str] = []
        for position, chapter in enumerate(chapters, start=1):
            chapter_id = f"chapter-{position}"
            href = f"chapters/{position:04d}.xhtml"
            chapter_title = str(chapter.get("title") or f"第 {position} 话")
            paragraphs = chapter.get("paragraphs") if isinstance(chapter.get("paragraphs"), list) else []
            archive.writestr(
                f"OEBPS/{href}",
                _chapter_xhtml(chapter_title, [str(item) for item in paragraphs], epub_source_identity_tags(chapter)),
                compress_type=ZIP_DEFLATED,
            )
            manifest_items.append(f'<item id="{chapter_id}" href="{href}" media-type="application/xhtml+xml"/>')
            spine_items.append(f'<itemref idref="{chapter_id}"/>')
            nav_items.append(f'<li><a href="{href}">{escape(chapter_title)}</a></li>')
            ncx_items.append(
                f'<navPoint id="nav-{position}" playOrder="{position}"><navLabel><text>{escape(chapter_title)}</text></navLabel><content src="{href}"/></navPoint>'
            )
        archive.writestr("OEBPS/nav.xhtml", _nav_xhtml(title, nav_items), compress_type=ZIP_DEFLATED)
        archive.writestr("OEBPS/toc.ncx", _toc_ncx(book_uuid, title, ncx_items), compress_type=ZIP_DEFLATED)
        archive.writestr(
            "OEBPS/content.opf",
            _content_opf(
                author=author,
                book_uuid=book_uuid,
                description=description,
                manifest_items=manifest_items,
                source_url=source_url,
                spine_items=spine_items,
                title=title,
                tags=tags,
            ),
            compress_type=ZIP_DEFLATED,
        )
    return buffer.getvalue()


def append_translation_epub(*, original_epub: bytes, chapters: list[dict[str, object]], appended_paths: list[str] | None = None) -> bytes:
    """Append translated chapters while retaining every existing EPUB asset and chapter."""
    if not chapters:
        return original_epub

    with ZipFile(BytesIO(original_epub), "r") as source:
        seen = set()
        for item in source.infolist():
            if item.filename.lower().endswith(('.xhtml', '.html', '.htm')):
                seen.update(_source_keys(_read_source_identity(source, item)))
        _claim_source_chapters(chapters, seen)
        container_bytes = normalize_epub_container(source.read("META-INF/container.xml"))
        container = ET.fromstring(container_bytes)
        rootfile = next((element for element in container.iter() if element.tag.rsplit("}", 1)[-1] == "rootfile"), None)
        if rootfile is None or not rootfile.get("full-path"):
            raise ValueError("EPUB 缺少可识别的 OPF 内容清单")
        opf_path = posixpath.normpath(rootfile.get("full-path") or "")
        opf_directory = posixpath.dirname(opf_path)
        opf = ET.fromstring(source.read(opf_path))
        manifest = opf.find(f"{{{OPF_NS}}}manifest")
        spine = opf.find(f"{{{OPF_NS}}}spine")
        if manifest is None or spine is None:
            raise ValueError("EPUB 的 OPF 缺少 manifest 或 spine")
        if (opf.get('version') or '').startswith('3'):
            metadata = opf.find(f'{{{OPF_NS}}}metadata')
            if metadata is not None:
                # EPUB 3 requires exactly one modification timestamp. Imported
                # files can contain duplicates left by earlier metadata tools.
                for item in list(metadata):
                    if item.tag == f'{{{OPF_NS}}}meta' and item.get('property') == 'dcterms:modified':
                        metadata.remove(item)
                ET.SubElement(metadata, f'{{{OPF_NS}}}meta', {'property': 'dcterms:modified'}).text = (
                    datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
        _repair_image_media_types(source, manifest, opf_directory)

        existing_ids = {item.get("id") for item in manifest.findall(f"{{{OPF_NS}}}item")}
        token = uuid4().hex[:10]
        appended: list[tuple[str, str, str]] = []
        new_documents: dict[str, bytes] = {}
        for position, chapter in enumerate(chapters, start=1):
            chapter_index = int(chapter.get("index") or position)
            chapter_title = str(chapter.get("title") or f"第 {chapter_index} 话")
            paragraphs = chapter.get("paragraphs") if isinstance(chapter.get("paragraphs"), list) else []
            item_id = f"aisu-update-{chapter_index}-{token}"
            while item_id in existing_ids:
                item_id += "x"
            existing_ids.add(item_id)
            # Reader positions and source ordinals can coincide when importing
            # old manual notes. Each document still needs its own ZIP member.
            href = f"aisu-updates/{chapter_index:05d}-{token}-{position}.xhtml"
            document_path = posixpath.normpath(posixpath.join(opf_directory, href))
            if appended_paths is not None:
                appended_paths.append(document_path)
            ET.SubElement(manifest, f"{{{OPF_NS}}}item", {"id": item_id, "href": href, "media-type": "application/xhtml+xml"})
            ET.SubElement(spine, f"{{{OPF_NS}}}itemref", {"idref": item_id})
            new_documents[document_path] = _appended_chapter_xhtml(chapter_title, [str(item) for item in paragraphs], epub_source_identity_tags(chapter)).encode("utf-8")
            appended.append((item_id, document_path, chapter_title))

        modified_documents: dict[str, bytes] = {opf_path: _serialize_xml(opf)}
        if container_bytes != source.read("META-INF/container.xml"):
            modified_documents["META-INF/container.xml"] = container_bytes
        nav_item = next(
            (item for item in manifest.findall(f"{{{OPF_NS}}}item") if "nav" in (item.get("properties") or "").split()),
            None,
        )
        if nav_item is not None and nav_item.get("href"):
            nav_path = posixpath.normpath(posixpath.join(opf_directory, nav_item.get("href") or ""))
            if nav_path in source.namelist():
                nav = ET.fromstring(source.read(nav_path))
                toc = next(
                    (
                        item
                        for item in nav.findall(f".//{{{XHTML_NS}}}nav")
                        if item.get(f"{{{EPUB_NS}}}type") == "toc" or item.get("role") == "doc-toc"
                    ),
                    None,
                )
                if toc is not None:
                    ordered_list = toc.find(f"{{{XHTML_NS}}}ol")
                    if ordered_list is None:
                        ordered_list = ET.SubElement(toc, f"{{{XHTML_NS}}}ol")
                    nav_directory = posixpath.dirname(nav_path)
                    for _item_id, document_path, chapter_title in appended:
                        entry = ET.SubElement(ordered_list, f"{{{XHTML_NS}}}li")
                        link = ET.SubElement(entry, f"{{{XHTML_NS}}}a", {"href": posixpath.relpath(document_path, nav_directory or ".")})
                        link.text = chapter_title
                    modified_documents[nav_path] = _serialize_xml(nav)

        ncx_id = spine.get("toc")
        ncx_item = next(
            (
                item
                for item in manifest.findall(f"{{{OPF_NS}}}item")
                if (ncx_id and item.get("id") == ncx_id) or item.get("media-type") == "application/x-dtbncx+xml"
            ),
            None,
        )
        if ncx_item is not None and ncx_item.get("href"):
            ncx_path = posixpath.normpath(posixpath.join(opf_directory, ncx_item.get("href") or ""))
            if ncx_path in source.namelist():
                ncx = ET.fromstring(source.read(ncx_path))
                nav_map = ncx.find(f"{{{NCX_NS}}}navMap")
                if nav_map is not None:
                    existing_orders = [
                        int(value)
                        for point in nav_map.findall(f".//{{{NCX_NS}}}navPoint")
                        if (value := point.get("playOrder")) and value.isdigit()
                    ]
                    next_order = max(existing_orders, default=0) + 1
                    ncx_directory = posixpath.dirname(ncx_path)
                    for offset, (item_id, document_path, chapter_title) in enumerate(appended):
                        point = ET.SubElement(nav_map, f"{{{NCX_NS}}}navPoint", {"id": item_id, "playOrder": str(next_order + offset)})
                        label = ET.SubElement(point, f"{{{NCX_NS}}}navLabel")
                        ET.SubElement(label, f"{{{NCX_NS}}}text").text = chapter_title
                        ET.SubElement(point, f"{{{NCX_NS}}}content", {"src": posixpath.relpath(document_path, ncx_directory or ".")})
                    modified_documents[ncx_path] = _serialize_xml(ncx)

        buffer = BytesIO()
        with ZipFile(buffer, "w") as target:
            mimetype = source.read("mimetype") if "mimetype" in source.namelist() else b"application/epub+zip"
            target.writestr("mimetype", mimetype, compress_type=ZIP_STORED)
            for info in source.infolist():
                if info.filename == "mimetype" or info.filename in modified_documents or info.filename in new_documents:
                    continue
                target.writestr(info, source.read(info.filename))
            for path, data in modified_documents.items():
                target.writestr(path, data, compress_type=ZIP_DEFLATED)
            for path, data in new_documents.items():
                target.writestr(path, data, compress_type=ZIP_DEFLATED)
        return buffer.getvalue()


def _repair_image_media_types(source: ZipFile, manifest: ET.Element, opf_directory: str) -> None:
    """Keep image bytes/paths intact while correcting mislabeled raster MIME types."""
    names = set(source.namelist())
    for item in manifest.findall(f"{{{OPF_NS}}}item"):
        if not (item.get("media-type") or "").startswith("image/"):
            continue
        path = posixpath.normpath(posixpath.join(opf_directory, unquote(item.get("href") or "")))
        if path not in names:
            continue
        with source.open(path) as image_file:
            header = image_file.read(16)
        detected = None
        if header.startswith(b"\xff\xd8\xff"):
            detected = "image/jpeg"
        elif header.startswith(b"\x89PNG\r\n\x1a\n"):
            detected = "image/png"
        elif header.startswith((b"GIF87a", b"GIF89a")):
            detected = "image/gif"
        elif header.startswith(b"RIFF") and header[8:12] == b"WEBP":
            detected = "image/webp"
        if detected:
            item.set("media-type", detected)


def normalize_epub_container(data: bytes) -> bytes:
    """Repair legacy container namespaces without changing package references."""
    container = ET.fromstring(data)
    if container.tag.rsplit("}", 1)[-1] != "container":
        raise ValueError("EPUB 容器缺少 container 根节点")
    changed = False
    for element in container.iter():
        local_name = element.tag.rsplit("}", 1)[-1]
        if local_name in {"container", "rootfiles", "rootfile"}:
            canonical = f"{{{CONTAINER_NS}}}{local_name}"
            if element.tag != canonical:
                element.tag = canonical
                changed = True
    return _serialize_xml(container) if changed else data


def _serialize_xml(root: ET.Element) -> bytes:
    ET.register_namespace("", root.tag[1:].split("}", 1)[0] if root.tag.startswith("{") else "")
    ET.register_namespace("epub", EPUB_NS)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _appended_chapter_xhtml(title: str, paragraphs: list[str], source_tags: str = '') -> str:
    body = "\n".join('<p>' + '<br/>'.join(escape(line) for line in paragraph.lstrip(' \u3000').split('\n')) + '</p>' for paragraph in paragraphs)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">
<head><meta charset="UTF-8"/><title>{escape(title)}</title>{source_tags}</head>
<body><article><h1>{escape(title)}</h1>{body}</article></body>
</html>"""


def _container_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""


def _chapter_xhtml(title: str, paragraphs: list[str], source_tags: str = '') -> str:
    body = "\n".join('<p>' + '<br/>'.join(escape(line) for line in paragraph.lstrip(' \u3000').split('\n')) + '</p>' for paragraph in paragraphs)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">
<head><meta charset="UTF-8"/><title>{escape(title)}</title>{source_tags}<link rel="stylesheet" href="../style.css" type="text/css"/></head>
<body><article><h1>{escape(title)}</h1>{body}</article></body>
</html>"""


def _nav_xhtml(title: str, items: list[str]) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><meta charset="UTF-8"/><title>目录</title></head>
<body><nav epub:type="toc" id="toc"><h1>{escape(title)}</h1><ol>{''.join(items)}</ol></nav></body>
</html>"""


def _toc_ncx(book_uuid: str, title: str, items: list[str]) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:{book_uuid}"/></head><docTitle><text>{escape(title)}</text></docTitle><navMap>{''.join(items)}</navMap>
</ncx>"""


def _content_opf(
    *,
    author: str,
    book_uuid: str,
    description: str,
    manifest_items: list[str],
    source_url: str,
    spine_items: list[str],
    title: str,
    tags: list[str] | None = None,
) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0" xml:lang="zh-CN">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="book-id">urn:uuid:{book_uuid}</dc:identifier><dc:title>{escape(title)}</dc:title>
<dc:creator>{escape(author)}</dc:creator><dc:language>zh-CN</dc:language>
<dc:description>{escape(description)}</dc:description><dc:source>{escape(source_url)}</dc:source>
{''.join(f'<dc:subject>{escape(tag)}</dc:subject>' for tag in (tags or []))}
<meta property="dcterms:modified">{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}</meta>
</metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="style.css" media-type="text/css"/>{''.join(manifest_items)}</manifest>
<spine toc="ncx">{''.join(spine_items)}</spine></package>"""


def _stylesheet() -> str:
    return """body { font-family: serif; line-height: 1.85; margin: 0 5%; }
h1 { font-size: 1.35em; margin: 2em 0 1.5em; }
p { margin: 0 0 1em; text-indent: 2em; }
p:first-of-type { text-indent: 0; }"""
