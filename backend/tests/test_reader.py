import base64
from datetime import datetime, timedelta, timezone
from io import BytesIO
from zipfile import ZipFile

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from app.modules.book_assets.domain import BookAsset
from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.reader.service import (
    build_reader_chapter_blocks,
    filter_readable_text_assets,
    get_reader_progress_weight,
    split_paragraphs,
    strip_leading_chapter_title,
)

TINY_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lYt6KwAAAABJRU5ErkJggg=="
)


def make_png_bytes(width: int, height: int) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format="PNG")
    return buffer.getvalue()


ILLUSTRATION_PNG_BYTES = make_png_bytes(320, 240)
PAGE_PNG_BYTES = make_png_bytes(640, 900)


def test_reader_preserves_one_txt_line_as_one_paragraph() -> None:
    content = "第一话 在公园遇见了幼女\n我是本堂奏。\n正在过着没有任何起伏的高中生活。\n——我曾这样想过。"

    assert split_paragraphs(content) == [
        "第一话 在公园遇见了幼女",
        "我是本堂奏。",
        "正在过着没有任何起伏的高中生活。",
        "——我曾这样想过。",
    ]
    assert strip_leading_chapter_title(content, "第一话 在公园遇见了幼女") == (
        "我是本堂奏。\n\n正在过着没有任何起伏的高中生活。\n\n——我曾这样想过。"
    )


def test_reader_builds_separate_blocks_for_single_newline_txt_paragraphs() -> None:
    blocks = build_reader_chapter_blocks("第一段。\r\n第二段。\r第三段。", "book")

    assert [block.text for block in blocks] == ["第一段。", "第二段。", "第三段。"]


def test_reader_progress_weight_treats_a_single_image_as_short_content() -> None:
    created_at = datetime.now(timezone.utc)
    image_chapter = BookAsset(
        id="image-chapter",
        book_id="book",
        asset_type="text_chapter",
        path="chapter-image.txt",
        index=1,
        metadata={"image_count": 1, "text_length": 0},
        created_at=created_at,
    )
    text_chapter = BookAsset(
        id="text-chapter",
        book_id="book",
        asset_type="text_chapter",
        path="chapter-text.txt",
        index=2,
        metadata={"image_count": 0, "text_length": 5000},
        created_at=created_at,
    )

    assert get_reader_progress_weight(image_chapter) == 180
    assert get_reader_progress_weight(text_chapter) == 5000


def test_reader_filters_front_matter_by_epub_source_when_title_is_misdetected() -> None:
    created_at = datetime.now(timezone.utc)
    cover = BookAsset(
        id="cover",
        book_id="book",
        asset_type="text_chapter",
        path="cover.txt",
        index=1,
        metadata={"source": "OEBPS/cover.xhtml", "title": "第 1 章", "text_length": 20},
        created_at=created_at,
    )
    chapter = BookAsset(
        id="chapter",
        book_id="book",
        asset_type="text_chapter",
        path="chapter.txt",
        index=2,
        metadata={"source": "OEBPS/chap01.xhtml", "title": "第01话", "text_length": 2000},
        created_at=created_at,
    )

    assert filter_readable_text_assets([cover, chapter]) == [chapter]


def make_epub_with_documents(documents: list[tuple[str, str]]) -> bytes:
    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
""",
        )
        manifest = "".join(
            f'<item id="doc-{index}" href="doc-{index}.xhtml" media-type="application/xhtml+xml" />'
            for index, _document in enumerate(documents, start=1)
        )
        spine = "".join(f'<itemref idref="doc-{index}" />' for index in range(1, len(documents) + 1))
        archive.writestr(
            "OPS/content.opf",
            f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Reader Filter Test</dc:title>
  </metadata>
  <manifest>{manifest}</manifest>
  <spine>{spine}</spine>
</package>
""",
        )
        for index, (title, body) in enumerate(documents, start=1):
            archive.writestr(
                f"OPS/doc-{index}.xhtml",
                f"""<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <h1>{title}</h1>
    <p>{body}</p>
  </body>
</html>
""",
            )

    return buffer.getvalue()


def make_epub_with_ncx_titles() -> bytes:
    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
""",
        )
        archive.writestr(
            "content.opf",
            """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>NCX Title Test</dc:title>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
    <item id="chapter-1" href="index_split_000.html" media-type="application/xhtml+xml" />
    <item id="chapter-2" href="index_split_001.html" media-type="application/xhtml+xml" />
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter-1" />
    <itemref idref="chapter-2" />
  </spine>
</package>
""",
        )
        archive.writestr(
            "toc.ncx",
            """<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="nav-1" playOrder="1">
      <navLabel><text>第一章 因为百合营业是工作</text></navLabel>
      <content src="index_split_000.html" />
    </navPoint>
    <navPoint id="nav-2" playOrder="2">
      <navLabel><text>第一话 序章与姐妹百合</text></navLabel>
      <content src="index_split_001.html" />
    </navPoint>
  </navMap>
</ncx>
""",
        )
        archive.writestr(
            "index_split_000.html",
            "<html><body><h1>第一章 因为百合营业是工作</h1><p>第一章 因为百合营业是工作</p><p>第一章正文。</p></body></html>",
        )
        archive.writestr(
            "index_split_001.html",
            "<html><body><h1>0ooyjjaq</h1><p>第一话正文。</p></body></html>",
        )

    return buffer.getvalue()


def make_epub_with_nav_in_spine() -> bytes:
    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
""",
        )
        archive.writestr(
            "EPUB/package.opf",
            """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Nav In Spine Test</dc:title>
  </metadata>
  <manifest>
    <item id="about" href="about.xhtml" media-type="application/xhtml+xml" />
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="volume-1" href="text/volume-001.xhtml" media-type="application/xhtml+xml" />
    <item id="chapter-1" href="text/chapter-001.xhtml" media-type="application/xhtml+xml" />
  </manifest>
  <spine>
    <itemref idref="about" />
    <itemref idref="nav" />
    <itemref idref="volume-1" />
    <itemref idref="chapter-1" />
  </spine>
</package>
""",
        )
        archive.writestr(
            "EPUB/nav.xhtml",
            """<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="about.xhtml">作品信息</a></li>
        <li>
          <a href="text/volume-001.xhtml">第一卷</a>
          <ol><li><a href="text/chapter-001.xhtml">第1话 正文开始</a></li></ol>
        </li>
      </ol>
    </nav>
  </body>
</html>
""",
        )
        archive.writestr("EPUB/about.xhtml", "<html><body><h1>作品信息</h1><p>译者信息。</p></body></html>")
        archive.writestr("EPUB/text/volume-001.xhtml", "<html><body><h1>第一卷</h1><p>第一卷</p></body></html>")
        archive.writestr("EPUB/text/chapter-001.xhtml", "<html><body><h1>错误的第一行</h1><p>正文。</p></body></html>")

    return buffer.getvalue()


def make_image_page_epub(page_count: int, title_factory) -> bytes:
    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
""",
        )
        document_manifest = "".join(
            f'<item id="page-{index}" href="page-{index}.xhtml" media-type="application/xhtml+xml" />'
            for index in range(1, page_count + 1)
        )
        image_manifest = "".join(
            f'<item id="image-{index}" href="images/page-{index}.png" media-type="image/png" />'
            for index in range(1, page_count + 1)
        )
        spine = "".join(f'<itemref idref="page-{index}" />' for index in range(1, page_count + 1))
        archive.writestr(
            "OPS/content.opf",
            f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Image EPUB</dc:title>
  </metadata>
  <manifest>{document_manifest}{image_manifest}</manifest>
  <spine>{spine}</spine>
</package>
""",
        )
        for index in range(1, page_count + 1):
            archive.writestr(
                f"OPS/page-{index}.xhtml",
                f'<html><body><h1>{title_factory(index)}</h1><img src="images/page-{index}.png" /></body></html>',
            )
            archive.writestr(f"OPS/images/page-{index}.png", PAGE_PNG_BYTES)

    return buffer.getvalue()


def make_multi_image_document_epub(page_count: int) -> bytes:
    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
""",
        )
        image_manifest = "".join(
            f'<item id="image-{index}" href="index-{index}_1.jpg" media-type="image/jpeg" />'
            for index in range(1, page_count + 1)
        )
        page_images = "".join(f'<img src="index-{index}_1.jpg" />' for index in range(1, page_count + 1))
        archive.writestr(
            "content.opf",
            f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Multi Image EPUB</dc:title>
  </metadata>
  <manifest>
    <item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml" />
    <item id="index" href="index.html" media-type="application/xhtml+xml" />
    {image_manifest}
  </manifest>
  <spine>
    <itemref idref="titlepage" />
    <itemref idref="index" />
  </spine>
</package>
""",
        )
        archive.writestr("titlepage.xhtml", "<html><body><h1>Cover</h1></body></html>")
        archive.writestr("index.html", f"<html><body><p>/app/public/task/source.pdf</p>{page_images}</body></html>")
        for index in range(1, page_count + 1):
            archive.writestr(f"index-{index}_1.jpg", PAGE_PNG_BYTES)

    return buffer.getvalue()


def make_epub_with_inline_illustration() -> bytes:
    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
""",
        )
        archive.writestr(
            "OPS/content.opf",
            """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Illustrated Novel</dc:title>
  </metadata>
  <manifest>
    <item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml" />
    <item id="illustration-1" href="images/illustration-1.png" media-type="image/png" />
  </manifest>
  <spine>
    <itemref idref="chapter-1" />
  </spine>
</package>
""",
        )
        archive.writestr(
            "OPS/chapter-1.xhtml",
            """<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <h1>第1话 插画测试</h1>
    <p>插图之前的正文。</p>
    <img src="images/illustration-1.png" />
    <p>插图之后的正文。</p>
  </body>
</html>
""",
        )
        archive.writestr("OPS/images/illustration-1.png", ILLUSTRATION_PNG_BYTES)

    return buffer.getvalue()


def make_epub_with_inline_annotation_icon() -> bytes:
    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
""",
        )
        archive.writestr(
            "OPS/content.opf",
            """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Annotation Icon Novel</dc:title>
  </metadata>
  <manifest>
    <item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml" />
    <item id="note-icon" href="images/note-icon.png" media-type="image/png" />
  </manifest>
  <spine>
    <itemref idref="chapter-1" />
  </spine>
</package>
""",
        )
        archive.writestr(
            "OPS/chapter-1.xhtml",
            """<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <h1>Annotation Icon Test</h1>
    <p>Before the note marker.</p>
    <img src="images/note-icon.png" width="16" height="16" alt="note" />
    <p>After the note marker.</p>
  </body>
</html>
""",
        )
        archive.writestr("OPS/images/note-icon.png", TINY_PNG_BYTES)

    return buffer.getvalue()


def test_gets_novel_reader_resource(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.get("/api/v1/books/b1/reader", headers=auth_headers)

    assert response.status_code == 200
    payload = response.json()
    assert payload["reader_type"] == "epub"
    # A book with no extracted chapters and no original file reports an empty TOC
    # rather than fabricating placeholder chapters that 404 when opened.
    assert payload["chapter_count"] == 0
    assert payload["toc"] == []


def test_gets_novel_reader_startup_bundle(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.get("/api/v1/books/b1/reader/startup?chapter_index=2", headers=auth_headers)

    assert response.status_code == 200
    payload = response.json()
    assert payload["book"]["id"] == "b1"
    assert payload["resource"]["reader_type"] == "epub"
    assert payload["progress"]["book_id"] == "b1"
    assert payload["chapter"] is None
    assert isinstance(payload["marks"], list)


def test_gets_comic_reader_resource(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.get("/api/v1/books/b3/reader", headers=auth_headers)

    assert response.status_code == 200
    payload = response.json()
    assert payload["reader_type"] == "comic"
    assert payload["page_count"] == 0
    assert payload["pages"] == []


def test_gets_uploaded_comic_reader_pages_from_assets(client: TestClient, auth_headers: dict[str, str]) -> None:
    archive_bytes = BytesIO()
    with ZipFile(archive_bytes, "w") as archive:
        archive.writestr("001.png", TINY_PNG_BYTES)
        archive.writestr("002.png", TINY_PNG_BYTES)

    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("comic.cbz", BytesIO(archive_bytes.getvalue()), "application/zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    response = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers)

    assert response.status_code == 200
    payload = response.json()
    assert payload["reader_type"] == "comic"
    assert payload["page_count"] == 2
    page = payload["pages"][0]
    assert page["position_key"]
    assert page == {"index": 1, "position_key": page["position_key"], "image_url": f"/api/v1/files/books/{book_id}/pages/1?position_key={page['position_key']}"}

    page_response = client.get(payload["pages"][0]["image_url"], headers=auth_headers)
    assert page_response.status_code == 200
    assert page_response.content == TINY_PNG_BYTES


def test_uploaded_epub_reader_returns_inline_illustration_blocks(client: TestClient, auth_headers: dict[str, str]) -> None:
    epub_bytes = make_epub_with_inline_illustration()
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("illustrated-novel.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter_response.status_code == 200
    chapter_payload = chapter_response.json()

    assert chapter_payload["content"] == "插图之前的正文。\n\n插图之后的正文。"
    assert chapter_payload["blocks"][0] == {"type": "paragraph", "alt": None, "image_url": None, "image_width": None, "image_height": None, "text": "插图之前的正文。", "spans": None, "level": None}
    assert chapter_payload["blocks"][1] == {
        "type": "image",
        "alt": "第 1 张插图",
        "image_url": f"/api/v1/files/books/{book_id}/chapter-images/1",
        "image_width": 320,
        "image_height": 240,
        "text": None,
        "spans": None,
        "level": None,
    }

    image_response = client.get(chapter_payload["blocks"][1]["image_url"], headers=auth_headers)
    assert image_response.status_code == 200
    assert image_response.content == ILLUSTRATION_PNG_BYTES


def test_uploaded_epub_reader_skips_inline_annotation_icon_blocks(client: TestClient, auth_headers: dict[str, str]) -> None:
    epub_bytes = make_epub_with_inline_annotation_icon()
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("annotation-icon.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter_response.status_code == 200
    chapter_payload = chapter_response.json()

    assert chapter_payload["content"] == "Before the note marker.\n\nAfter the note marker."
    assert [block["type"] for block in chapter_payload["blocks"]] == ["paragraph", "paragraph"]

    image_response = client.get(f"/api/v1/files/books/{book_id}/chapter-images/1", headers=auth_headers)
    assert image_response.status_code == 404


def test_uploaded_epub_reader_uses_ncx_titles_for_toc(client: TestClient, auth_headers: dict[str, str]) -> None:
    epub_bytes = make_epub_with_ncx_titles()
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("ncx-title-test.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    resource_response = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers)
    assert resource_response.status_code == 200
    payload = resource_response.json()
    assert [{"index": item["index"], "title": item["title"]} for item in payload["toc"]] == [
        {"index": 1, "title": "第一章 因为百合营业是工作"},
        {"index": 2, "title": "第一话 序章与姐妹百合"},
    ]
    assert all(item["progress_weight"] > 0 for item in payload["toc"])

    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter_response.status_code == 200
    assert chapter_response.json()["title"] == "第一章 因为百合营业是工作"
    assert chapter_response.json()["content"] == "第一章正文。"


def test_uploaded_epub_reader_skips_nav_documents_in_spine(client: TestClient, auth_headers: dict[str, str]) -> None:
    epub_bytes = make_epub_with_nav_in_spine()
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("nav-in-spine.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    resource_response = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers)
    assert resource_response.status_code == 200
    payload = resource_response.json()
    assert payload["chapter_count"] == 2
    assert payload["toc"][0]["index"] == 1
    assert payload["toc"][0]["title"] == "第一卷"
    assert payload["toc"][0]["level"] == 1
    assert payload["toc"][0]["progress_weight"] > 0
    assert payload["toc"][1]["title"] == "第1话 正文开始"
    assert payload["toc"][1]["level"] == 2

    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/2", headers=auth_headers)
    assert chapter_response.status_code == 200
    chapter_payload = chapter_response.json()
    assert chapter_payload["title"] == "第1话 正文开始"
    assert "作品信息" not in chapter_payload["content"]


def test_pdf_reader_resource_does_not_forge_pages(client: TestClient, auth_headers: dict[str, str]) -> None:
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("manual.pdf", BytesIO(b"%PDF-1.4"), "application/pdf")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    response = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers)

    assert response.status_code == 200
    payload = response.json()
    assert payload["reader_type"] == "pdf"
    assert payload["file_url"].startswith(f"/api/v1/files/books/{book_id}/pdf-preview?ticket=")
    assert payload["page_count"] is None
    assert payload["pages"] == []

    preview_response = client.get(payload["file_url"])
    assert preview_response.status_code == 200
    assert preview_response.headers["content-type"].startswith("application/pdf")
    assert preview_response.headers["content-disposition"].startswith("inline")
    range_response = client.get(payload["file_url"], headers={"Range": "bytes=0-3"})
    assert range_response.status_code == 206
    assert range_response.headers["content-range"].startswith("bytes 0-3/")


def test_image_only_epub_reader_resource_is_not_treated_as_novel(client: TestClient, auth_headers: dict[str, str]) -> None:
    epub_bytes = make_image_page_epub(23, lambda index: f"第 {index} 页")

    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("image-only.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    detail_response = client.get(f"/api/v1/books/{book_id}", headers=auth_headers)
    assert detail_response.status_code == 200
    assert detail_response.json()["kind"] == "manga"
    assert detail_response.json()["reader_type"] == "comic"

    resource_response = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers)
    assert resource_response.status_code == 200
    payload = resource_response.json()
    assert payload["reader_type"] == "comic"
    assert payload["page_count"] == 23
    page = payload["pages"][0]
    assert page["position_key"]
    assert page == {"index": 1, "position_key": page["position_key"], "image_url": f"/api/v1/files/books/{book_id}/pages/1?position_key={page['position_key']}"}

    page_response = client.get(payload["pages"][0]["image_url"], headers=auth_headers)
    assert page_response.status_code == 200
    assert page_response.content == PAGE_PNG_BYTES

    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter_response.status_code == 404


def test_text_heavy_epub_with_page_named_chapters_stays_a_novel(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    epub_bytes = make_epub_with_documents(
        [
            (f"{index}页/第{index}话", "这是一段正常小说正文。" * 80)
            for index in range(1, 51)
        ]
    )

    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("page-named-novel.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    detail = client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()
    assert detail["kind"] == "novel"
    assert detail["reader_type"] == "epub"

    resource = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers).json()
    assert resource["reader_type"] == "epub"
    assert resource["chapter_count"] == 50
    assert resource["toc"][0]["title"] == "1页/第1话"


def test_repeated_short_title_epub_reader_resource_extracts_comic_pages(client: TestClient, auth_headers: dict[str, str]) -> None:
    epub_bytes = make_image_page_epub(24, lambda _index: "雨夜之月 - 卷03")

    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("repeated-title.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    resource_response = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers)
    assert resource_response.status_code == 200
    payload = resource_response.json()
    assert payload["reader_type"] == "comic"
    assert payload["page_count"] == 24
    page = payload["pages"][-1]
    assert page["position_key"]
    assert page == {"index": 24, "position_key": page["position_key"], "image_url": f"/api/v1/files/books/{book_id}/pages/24?position_key={page['position_key']}"}

    page_response = client.get(payload["pages"][-1]["image_url"], headers=auth_headers)
    assert page_response.status_code == 200
    assert page_response.content == PAGE_PNG_BYTES

    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter_response.status_code == 404


def test_multi_image_document_epub_reader_resource_extracts_all_comic_pages(client: TestClient, auth_headers: dict[str, str]) -> None:
    epub_bytes = make_multi_image_document_epub(35)

    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("multi-image.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    resource_response = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers)
    assert resource_response.status_code == 200
    payload = resource_response.json()
    assert payload["reader_type"] == "comic"
    assert payload["page_count"] == 35
    page = payload["pages"][0]
    assert page["position_key"]
    assert page == {"index": 1, "position_key": page["position_key"], "image_url": f"/api/v1/files/books/{book_id}/pages/1?position_key={page['position_key']}"}
    page = payload["pages"][-1]
    assert page["position_key"]
    assert page == {"index": 35, "position_key": page["position_key"], "image_url": f"/api/v1/files/books/{book_id}/pages/35?position_key={page['position_key']}"}

    page_response = client.get(payload["pages"][-1]["image_url"], headers=auth_headers)
    assert page_response.status_code == 200
    assert page_response.content == PAGE_PNG_BYTES

    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter_response.status_code == 404


def test_reader_skips_epub_front_matter_when_building_toc(client: TestClient, auth_headers: dict[str, str]) -> None:
    epub_bytes = make_epub_with_documents(
        [
            ("封面", "封面"),
            ("扉页", "Reader Filter Test"),
            ("标题", "Reader Filter Test"),
            ("作品信息", "测试作品信息"),
            ("制作信息", "测试制作信息"),
            ("制作人员", "测试制作人员"),
            ("插图", "插图"),
            ("第1话 正文开始", "这是第一段真正的正文内容。"),
            ("第2话 继续阅读", "这是第二段真正的正文内容。"),
        ]
    )
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("front-matter.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    resource_response = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers)
    assert resource_response.status_code == 200
    payload = resource_response.json()
    assert payload["chapter_count"] == 2
    assert [{"index": item["index"], "title": item["title"]} for item in payload["toc"]] == [
        {"index": 1, "title": "第1话 正文开始"},
        {"index": 2, "title": "第2话 继续阅读"},
    ]
    assert all(item["progress_weight"] > 0 for item in payload["toc"])

    detail_response = client.get(f"/api/v1/books/{book_id}", headers=auth_headers)
    assert detail_response.status_code == 200
    assert detail_response.json()["current_chapter"] == "第1话 正文开始"

    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter_response.status_code == 200
    chapter_payload = chapter_response.json()
    assert chapter_payload["title"] == "第1话 正文开始"
    assert "真正的正文内容" in chapter_payload["content"]
    assert "第1话 正文开始" not in chapter_payload["content"]
    assert "制作信息" not in chapter_payload["content"]
    assert "作品信息" not in chapter_payload["content"]


def make_epub_with_rich_chapter(body: str | None = None) -> bytes:
    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
""",
        )
        archive.writestr(
            "OPS/content.opf",
            """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Rich Novel</dc:title>
  </metadata>
  <manifest>
    <item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml" />
  </manifest>
  <spine>
    <itemref idref="chapter-1" />
  </spine>
</package>
""",
        )
        archive.writestr(
            "OPS/chapter-1.xhtml",
            f'<html><body><h1>第1话 觉醒之刻</h1>{body}</body></html>' if body is not None else """<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <h1>第1话 觉醒之刻</h1>
    <h2>序幕</h2>
    <p>他<strong>猛地</strong>睁开眼，看向<em>远方</em>的天空。</p>
    <p><ruby><rb>漢字</rb><rt>かんじ</rt></ruby>缓缓浮现，<span style="text-emphasis: filled dot">意义非凡</span>。</p>
  </body>
</html>
""",
        )

    return buffer.getvalue()


@pytest.mark.parametrize(
    ("body", "paragraphs"),
    [
        (
            "<p><ruby>東京<rt>とうきょう</rt></ruby>タワー。</p><p>夜の散歩。</p>",
            ["東京タワー。", "夜の散歩。"],
        ),
        (
            "<p>ひとつの\n段落です。</p><h2>場面転換</h2><p>次の段落。</p>",
            ["ひとつの 段落です。", "場面転換", "次の段落。"],
        ),
        (
            "<p>彼女は窓を開けて、\n静かな夜空を見上げた。</p>",
            ["彼女は窓を開けて、 静かな夜空を見上げた。"],
        ),
    ],
    ids=["ruby-base", "source-formatting", "single-paragraph"],
)
def test_reader_and_audiobook_share_visible_epub_paragraphs(
    client: TestClient, auth_headers: dict[str, str], body: str, paragraphs: list[str],
) -> None:
    uploaded = client.post("/api/v1/uploads/books", headers=auth_headers,
        files={"file": ("paragraphs.epub", BytesIO(make_epub_with_rich_chapter(body)), "application/epub+zip")})
    assert uploaded.status_code == 200
    book_id = uploaded.json()["book_id"]
    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter_response.status_code == 200
    chapter = chapter_response.json()
    assert [block["text"] for block in chapter["blocks"] if block["type"] != "image"] == paragraphs
    assert chapter["content"].split("\n\n") == paragraphs

    ticket_response = client.post(f"/api/v1/books/{book_id}/reader/chapters/1/audiobook", headers=auth_headers)
    assert ticket_response.status_code == 200
    timeline_response = client.get(ticket_response.json()["timeline_url"])
    assert timeline_response.status_code == 200
    assert [cue["paragraph_index"] for cue in timeline_response.json()["cues"]] == list(range(len(paragraphs)))


def test_uploaded_epub_reader_returns_rich_text_blocks(client: TestClient, auth_headers: dict[str, str]) -> None:
    epub_bytes = make_epub_with_rich_chapter()
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("rich-novel.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter_response.status_code == 200
    blocks = chapter_response.json()["blocks"]

    # The leading heading that just repeats the chapter title is stripped.
    assert all(block.get("text") != "第1话 觉醒之刻" for block in blocks)
    # A genuine section heading survives with its level.
    assert any(block["type"] == "heading" and block["text"] == "序幕" and block["level"] == 2 for block in blocks)

    all_spans = [span for block in blocks if block.get("spans") for span in block["spans"]]
    assert {"text": "猛地", "marks": ["strong"], "ruby": None} in all_spans
    assert {"text": "远方", "marks": ["emphasis"], "ruby": None} in all_spans
    assert {"text": "漢字", "marks": [], "ruby": "かんじ"} in all_spans
    assert {"text": "意义非凡", "marks": ["emphasis_dot"], "ruby": None} in all_spans


def test_reader_falls_back_to_plain_text_when_rich_sidecar_missing(client: TestClient, auth_headers: dict[str, str], tmp_path) -> None:
    epub_bytes = make_epub_with_rich_chapter()
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("rich-novel.epub", BytesIO(epub_bytes), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    # Simulate a legacy book that was ingested before rich extraction existed:
    # the plain-text chapter remains but the structured sidecar is gone.
    removed_sidecars = 0
    for sidecar_path in (tmp_path / "storage").rglob("chapter-*.json"):
        sidecar_path.unlink()
        removed_sidecars += 1
    assert removed_sidecars >= 1

    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter_response.status_code == 200
    blocks = chapter_response.json()["blocks"]

    assert blocks
    assert all(block["type"] in ("paragraph", "image") for block in blocks)
    assert all(block["spans"] is None for block in blocks)
    assert any(block["type"] == "paragraph" and "睁开眼" in (block["text"] or "") for block in blocks)


def test_deleted_book_reader_is_not_readable(client: TestClient, auth_headers: dict[str, str]) -> None:
    delete_response = client.delete("/api/v1/books/b1", headers=auth_headers)
    assert delete_response.status_code == 204

    resource_response = client.get("/api/v1/books/b1/reader", headers=auth_headers)
    assert resource_response.status_code == 404

    chapter_response = client.get("/api/v1/books/b1/reader/chapters/1", headers=auth_headers)
    assert chapter_response.status_code == 404


def test_owner_can_append_pasted_chapter_to_uploaded_epub(client: TestClient, auth_headers: dict[str, str]) -> None:
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("serial.epub", BytesIO(make_epub_with_documents([("第 1 章", "已有正文。")])), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    with client.app.state.db_session_factory() as session:
        repository = SqlAlchemyBookRepository(session)
        book = repository.get_by_id(book_id)
        assert book is not None
        repository.save(book.with_changes(source_update_count=2))

    progress_response = client.put(
        f"/api/v1/books/{book_id}/progress",
        headers=auth_headers,
        json={"chapter_index": 1, "epub_cfi": "aisu-scroll:1.0000", "progress_percent": 100, "reader_type": "epub"},
    )
    assert progress_response.status_code == 200

    append_response = client.post(
        f"/api/v1/books/{book_id}/chapters",
        headers=auth_headers,
        json={"content": "第 2 章 新的相遇\n\n这是刚刚翻译好的正文。"},
    )
    assert append_response.status_code == 200
    assert append_response.json() == {
        "chapter_count": 2,
        "index": 2,
        "text_length": 11,
        "title": "第 2 章 新的相遇",
    }
    assert client.get(f"/api/v1/books/{book_id}", headers=auth_headers).json()["source_update_count"] == 1

    resource_response = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers)
    assert resource_response.status_code == 200
    assert resource_response.json()["chapter_count"] == 2
    position_key = resource_response.json()["toc"][-1]["position_key"]
    assert isinstance(position_key, str) and position_key
    assert resource_response.json()["toc"][-1] == {
        "content_version": resource_response.json()["toc"][-1]["content_version"],
        "position_key": position_key,
        "index": 2,
        "level": 1,
        "progress_weight": 11,
        "section_level": 1,
        "section_title": None,
        "title": "第 2 章 新的相遇",
    }

    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/2", headers=auth_headers)
    assert chapter_response.status_code == 200
    assert chapter_response.json()["content"] == "这是刚刚翻译好的正文。"
    assert chapter_response.json()["position_key"] == position_key

    updated_progress = client.get(f"/api/v1/books/{book_id}/progress", headers=auth_headers)
    assert updated_progress.status_code == 200
    assert updated_progress.json()["chapter_index"] == 1
    weights = [chapter["progress_weight"] for chapter in resource_response.json()["toc"]]
    assert updated_progress.json()["progress_percent"] == int(weights[0] / sum(weights) * 100 + .5)

    reprocess_response = client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=auth_headers)
    assert reprocess_response.status_code == 200
    reprocessed_resource = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers)
    assert reprocessed_resource.status_code == 200
    assert reprocessed_resource.json()["chapter_count"] == 2
    reprocessed_chapter = client.get(f"/api/v1/books/{book_id}/reader/chapters/2", headers=auth_headers)
    assert reprocessed_chapter.status_code == 200
    assert reprocessed_chapter.json()["content"] == "这是刚刚翻译好的正文。"

    duplicate_response = client.post(
        f"/api/v1/books/{book_id}/chapters",
        headers=auth_headers,
        json={"title": "重复章节", "content": "这是刚刚翻译好的正文。"},
    )
    assert duplicate_response.status_code == 409


@pytest.mark.parametrize("title,body,prepared", [
    (None, "第十二章的线索并不在书页上，而在信里。\n\n第二段保留。", False),
    ("第二话 夜雨", "第十二章已经结束。\n\n第二段保留。", False),
    ("第二话 夜雨", "第三章 这是正文里引用的章节名\n\n第二段保留。", True),
    ("第二话 夜雨", "第二话 夜雨\n\n她把这几个字又念了一次。", True),
])
def test_append_preserves_body_through_reader_and_reprocess(
    client: TestClient, auth_headers: dict[str, str], title: str | None, body: str, prepared: bool,
) -> None:
    uploaded = client.post("/api/v1/uploads/books", headers=auth_headers,
        files={"file": ("safe-append.epub", BytesIO(make_epub_with_documents([("第一话", "已有正文。") ])), "application/epub+zip")})
    assert uploaded.status_code == 200
    book_id = uploaded.json()["book_id"]
    response = client.post(f"/api/v1/books/{book_id}/chapters", headers=auth_headers,
        json={"title": title, "content": body, "content_is_body": prepared})
    assert response.status_code == 200
    assert response.json()["title"] == (title or "第 2 章")
    assert response.json()["text_length"] == len(body)
    for reprocess in (False, True):
        if reprocess:
            assert client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=auth_headers).status_code == 200
        reader = client.get(f"/api/v1/books/{book_id}/reader/chapters/2", headers=auth_headers)
        assert reader.status_code == 200
        assert reader.json()["content"] == body
        paragraphs = [block["text"] for block in reader.json()["blocks"] if block["type"] == "paragraph"]
        assert paragraphs == body.split("\n\n")


def test_manual_txt_import_keeps_prose_opening_before_and_after_reprocess(client: TestClient, auth_headers: dict[str, str]) -> None:
    body = "第十二章的线索并不在书页上，而在信里。\n\n第二段保留。"
    uploaded = client.post("/api/v1/uploads/books", headers=auth_headers,
        files={"file": ("manual-story.txt", (body + "\n").encode("utf-8"), "text/plain")})
    assert uploaded.status_code == 200
    book_id = uploaded.json()["book_id"]
    for reprocess in (False, True):
        if reprocess:
            assert client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=auth_headers).status_code == 200
        resource = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers).json()
        assert resource["chapter_count"] == 1
        assert resource["toc"][0]["title"] == "第 1 章"
        reader = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
        assert reader.json()["content"] == body


def test_legacy_epub_sidecar_chapter_is_not_reported_as_originally_editable(client: TestClient, auth_headers: dict[str, str]) -> None:
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("serial.epub", BytesIO(make_epub_with_documents([("第 1 章", "已有正文。")])), "application/epub+zip")},
    )
    book_id = upload_response.json()["book_id"]
    append_response = client.post(
        f"/api/v1/books/{book_id}/chapters",
        headers=auth_headers,
        json={"title": "第 2 章", "content": "原正文。"},
    )
    assert append_response.status_code == 200

    editable_response = client.get(f"/api/v1/books/{book_id}/chapters", headers=auth_headers)
    assert editable_response.status_code == 200
    assert editable_response.json() == [{"index": 1, "title": "第 1 章"}]

    edit_response = client.put(
        f"/api/v1/books/{book_id}/chapters/2",
        headers=auth_headers,
        json={"title": "第 2 章", "content": "第２話\n　　\n　　第一段。\n　　\n「第二段！」"},
    )
    assert edit_response.status_code == 400
    assert "尚未写入 EPUB" in edit_response.json()["detail"]


def test_owner_can_edit_epub_chapter_and_reprocess_original(client: TestClient, auth_headers: dict[str, str]) -> None:
    original_epub = make_epub_with_documents([("第 1 章", "旧正文。"), ("第 2 章", "不要修改。")])
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("editable.epub", BytesIO(original_epub), "application/epub+zip")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    editable_response = client.get(f"/api/v1/books/{book_id}/chapters/1/edit", headers=auth_headers)
    assert editable_response.status_code == 200
    editable = editable_response.json()
    assert len(editable.pop('revision')) == 64
    assert editable == {
        "content": "旧正文。",
        "format": "epub",
        "has_images": False,
        "index": 1,
        "title": "第 1 章",
    }

    edit_response = client.put(
        f"/api/v1/books/{book_id}/chapters/1",
        headers=auth_headers,
        json={"title": "第 1 章", "content": "修正后的第一段。\n\n修正后的第二段。"},
    )
    assert edit_response.status_code == 200

    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter_response.status_code == 200
    assert chapter_response.json()["content"] == "修正后的第一段。\n\n修正后的第二段。"

    original_response = client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers)
    assert original_response.status_code == 200
    with ZipFile(BytesIO(original_response.content)) as archive:
        rewritten_document = archive.read("OPS/doc-1.xhtml").decode("utf-8")
        untouched_document = archive.read("OPS/doc-2.xhtml").decode("utf-8")
        assert "修正后的第一段。" in rewritten_document
        assert "旧正文。" not in rewritten_document
        assert "不要修改。" in untouched_document

    reprocess_response = client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=auth_headers)
    assert reprocess_response.status_code == 200
    reprocessed_chapter = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert reprocessed_chapter.json()["content"] == "修正后的第一段。\n\n修正后的第二段。"


def test_epub_chapter_title_edit_updates_ncx_for_reprocessing(client: TestClient, auth_headers: dict[str, str]) -> None:
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("ncx-edit.epub", BytesIO(make_epub_with_ncx_titles()), "application/epub+zip")},
    )
    book_id = upload_response.json()["book_id"]
    edit_response = client.put(
        f"/api/v1/books/{book_id}/chapters/1",
        headers=auth_headers,
        json={"title": "第一章 修正后的标题", "content": "第一章正文已修正。"},
    )
    assert edit_response.status_code == 200

    reprocess_response = client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=auth_headers)
    assert reprocess_response.status_code == 200
    resource_response = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers)
    assert resource_response.json()["toc"][0]["title"] == "第一章 修正后的标题"


def test_epub_chapter_edit_preserves_inline_illustration(client: TestClient, auth_headers: dict[str, str]) -> None:
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("illustrated.epub", BytesIO(make_epub_with_inline_illustration()), "application/epub+zip")},
    )
    book_id = upload_response.json()["book_id"]
    editable_response = client.get(f"/api/v1/books/{book_id}/chapters/1/edit", headers=auth_headers)
    editable = editable_response.json()
    assert editable["has_images"] is True
    assert "[[AISU_CHAPTER_IMAGE:1]]" in editable["content"]

    missing_image_response = client.put(
        f"/api/v1/books/{book_id}/chapters/1",
        headers=auth_headers,
        json={"title": editable["title"], "content": "把插画删掉。"},
    )
    assert missing_image_response.status_code == 400

    edit_response = client.put(
        f"/api/v1/books/{book_id}/chapters/1",
        headers=auth_headers,
        json={"title": editable["title"], "content": "插图之前已修正。\n\n[[AISU_CHAPTER_IMAGE:1]]\n\n插图之后已修正。"},
    )
    assert edit_response.status_code == 200
    reprocess_response = client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=auth_headers)
    assert reprocess_response.status_code == 200
    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert [block["type"] for block in chapter_response.json()["blocks"]] == ["paragraph", "image", "paragraph"]


def test_owner_can_edit_txt_chapter_in_original_file(client: TestClient, auth_headers: dict[str, str]) -> None:
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("editable.txt", "第1章 开始\n\n旧的 TXT 正文。".encode("utf-8"), "text/plain")},
    )
    assert upload_response.status_code == 200
    book_id = upload_response.json()["book_id"]

    edit_response = client.put(
        f"/api/v1/books/{book_id}/chapters/1",
        headers=auth_headers,
        json={"title": "第1章 开始", "content": "新的 TXT 正文。"},
    )
    assert edit_response.status_code == 200
    original_response = client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers)
    assert original_response.status_code == 200
    assert original_response.content.decode("utf-8") == "第1章 开始\n\n新的 TXT 正文。\n"

    reprocess_response = client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=auth_headers)
    assert reprocess_response.status_code == 200
    chapter_response = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter_response.json()["content"] == "新的 TXT 正文。"


def test_owner_can_delete_epub_chapter_and_reindex_progress(client: TestClient, auth_headers: dict[str, str]) -> None:
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={
            "file": (
                "delete-chapter.epub",
                BytesIO(make_epub_with_documents([("第一话", "正文一。"), ("第二话", "正文二。"), ("第三话", "正文三。")])),
                "application/epub+zip",
            )
        },
    )
    book_id = upload_response.json()["book_id"]
    progress_response = client.put(
        f"/api/v1/books/{book_id}/progress",
        headers=auth_headers,
        json={"chapter_index": 3, "epub_cfi": "aisu-scroll:0.5000", "progress_percent": 83, "reader_type": "epub"},
    )
    assert progress_response.status_code == 200

    deleted = client.delete(f"/api/v1/books/{book_id}/chapters/2", headers=auth_headers)

    assert deleted.status_code == 200
    assert deleted.json() == {"chapter_count": 2, "deleted_index": 2, "next_index": 2}
    resource = client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers).json()
    assert [(item["index"], item["title"]) for item in resource["toc"]] == [(1, "第一话"), (2, "第三话")]
    assert client.get(f"/api/v1/books/{book_id}/reader/chapters/2", headers=auth_headers).json()["content"] == "正文三。"
    progress = client.get(f"/api/v1/books/{book_id}/progress", headers=auth_headers).json()
    assert progress["chapter_index"] == 2

    original = client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers)
    with ZipFile(BytesIO(original.content)) as archive:
        assert "OPS/doc-2.xhtml" not in archive.namelist()
        package = archive.read("OPS/content.opf").decode("utf-8")
        assert "doc-2.xhtml" not in package

    reprocessed = client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=auth_headers)
    assert reprocessed.status_code == 200
    assert client.get(f"/api/v1/books/{book_id}/reader/chapters/2", headers=auth_headers).json()["content"] == "正文三。"


def test_owner_can_delete_txt_chapter_from_original_file(client: TestClient, auth_headers: dict[str, str]) -> None:
    upload_response = client.post(
        "/api/v1/uploads/books",
        headers=auth_headers,
        files={"file": ("delete-chapter.txt", "第1章 开始\n\n正文一。\n\n第2章 继续\n\n正文二。\n\n第3章 结束\n\n正文三。".encode("utf-8"), "text/plain")},
    )
    book_id = upload_response.json()["book_id"]

    deleted = client.delete(f"/api/v1/books/{book_id}/chapters/2", headers=auth_headers)

    assert deleted.status_code == 200
    original = client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers)
    decoded = original.content.decode("utf-8")
    assert "正文二。" not in decoded
    assert "第1章 开始" in decoded
    assert "第3章 结束" in decoded


def test_delete_keeps_hidden_front_matter_in_asset_order(client: TestClient, auth_headers: dict[str, str]) -> None:
    from app.modules.book_assets.repository import SqlAlchemyBookAssetRepository

    response = client.post(
        "/api/v1/uploads/books", headers=auth_headers,
        files={"file": ("front-matter.epub", make_epub_with_documents([
            ("作品信息", "说明。"), ("第一话", "一。"), ("第二话", "二。"), ("第三话", "三。"),
        ]), "application/epub+zip")},
    )
    book_id = response.json()["book_id"]
    with client.app.state.db_session_factory() as session:
        repository = SqlAlchemyBookAssetRepository(session)
        first = repository.list_by_book(book_id, "text_chapter")[0]
        repository.update_metadata(first.id, {**first.metadata, "is_auxiliary": True})
    assert client.get(f"/api/v1/books/{book_id}/reader", headers=auth_headers).json()["chapter_count"] == 3
    assert client.delete(f"/api/v1/books/{book_id}/chapters/2", headers=auth_headers).status_code == 200
    with client.app.state.db_session_factory() as session:
        remaining = SqlAlchemyBookAssetRepository(session).list_by_book(book_id, "text_chapter")
        assert [asset.index for asset in remaining] == [1, 2, 3]
        assert [asset.metadata["title"] for asset in remaining] == ["作品信息", "第一话", "第三话"]


def test_delete_updates_positions_for_shared_readers(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.post(
        "/api/v1/uploads/books", headers=auth_headers,
        files={"file": ("shared.epub", make_epub_with_documents([
            ("第一话", "一。"), ("第二话", "二。"), ("第三话", "三。"),
        ]), "application/epub+zip")},
    )
    book_id = response.json()["book_id"]
    invitation = client.post("/api/v1/invitations/me", headers=auth_headers).json()["code"]
    registration = client.post("/api/v1/auth/register", json={
        "email": "delete-shared@example.com", "nickname": "读者", "password": "reader-password", "invitation_code": invitation,
    })
    assert registration.status_code == 200
    reader_headers = {"Authorization": f"Bearer {registration.json()['access_token']}"}
    client.post(f"/api/v1/books/{book_id}/share-request", headers=auth_headers)
    client.post(f"/api/v1/books/{book_id}/share-request/approve", headers=auth_headers)
    assert client.put(f"/api/v1/books/{book_id}/progress", headers=reader_headers,
        json={"reader_type": "epub", "progress_percent": 83, "chapter_index": 3, "epub_cfi": "aisu-scroll:0.5000",
              "updated_at": (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()}).status_code == 200
    for index in (1, 2, 3):
        assert client.post(f"/api/v1/books/{book_id}/marks", headers=reader_headers,
            json={"kind": "bookmark", "reader_type": "epub", "chapter_index": index, "progress_percent": 10}).status_code == 201
    assert client.delete(f"/api/v1/books/{book_id}/chapters/2", headers=auth_headers).status_code == 200
    progress = client.get(f"/api/v1/books/{book_id}/progress", headers=reader_headers).json()
    assert progress["chapter_index"] == 2
    assert progress["epub_cfi"] == "aisu-scroll:0.5000"
    marks = client.get(f"/api/v1/books/{book_id}/marks", headers=reader_headers).json()
    assert [mark["chapter_index"] for mark in marks] == [1, 2, 2]
    assert sum(mark["position_valid"] is False for mark in marks) == 1
    assert client.get(f"/api/v1/books/{book_id}/reader/startup", headers=reader_headers).json()["chapter"]["title"] == "第三话"


@pytest.mark.parametrize("body", [
    "第十二章的线索并不在书页上，而在信里。\n\n第二段保留。",
    "第一话 灯下的来信\n\n她把这几个字又念了一次。",
])
def test_chapter_edit_keeps_heading_like_prose_through_epub_reprocess(client: TestClient, auth_headers: dict[str, str], body: str) -> None:
    original = make_epub_with_documents([("第一话 灯下的来信", "原来的正文。"), ("第二话", "不要修改。")])
    upload = client.post("/api/v1/uploads/books", headers=auth_headers,
                         files={"file": ("preserve-prose.epub", BytesIO(original), "application/epub+zip")})
    assert upload.status_code == 200
    book_id = upload.json()["book_id"]
    response = client.put(f"/api/v1/books/{book_id}/chapters/1", headers=auth_headers,
                          json={"title": "第一话 灯下的来信", "content": body})
    assert response.status_code == 200
    editable = client.get(f"/api/v1/books/{book_id}/chapters/1/edit", headers=auth_headers)
    assert editable.json()["content"] == body
    before_reprocess = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers).json()
    assert before_reprocess["content"] == body
    assert [block["text"] for block in before_reprocess["blocks"] if block["type"] == "paragraph"] == body.split("\n\n")
    original_response = client.get(f"/api/v1/files/books/{book_id}/original", headers=auth_headers)
    with ZipFile(BytesIO(original_response.content)) as archive:
        document = archive.read("OPS/doc-1.xhtml").decode("utf-8")
        assert all(paragraph in document for paragraph in body.split("\n\n"))
        assert "不要修改。" in archive.read("OPS/doc-2.xhtml").decode("utf-8")
    assert client.post(f"/api/v1/uploads/books/{book_id}/reprocess", headers=auth_headers).status_code == 200
    chapter = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter.json()["content"] == body
    assert [block["text"] for block in chapter.json()["blocks"] if block["type"] == "paragraph"] == body.split("\n\n")
