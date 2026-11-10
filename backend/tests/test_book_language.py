from io import BytesIO
from xml.sax.saxutils import escape
from zipfile import ZipFile

import pytest
from fastapi.testclient import TestClient

from app.modules.books.factory import create_uploaded_book
from app.modules.books.repository import InMemoryBookRepository
from app.modules.books.service import list_books
from app.modules.processing.language import detect_book_language, normalize_declared_language
from app.modules.reading_progress.repository import InMemoryReadingProgressRepository


def make_book(book_id: str, language: str):
    return create_uploaded_book(
        author="Author",
        book_id=book_id,
        file_label=f"{book_id}.epub",
        kind="novel",
        owner_id="owner",
        reader_type="epub",
        tags=(),
        title=book_id,
    ).with_changes(language=language)


def test_detects_declared_and_text_languages() -> None:
    assert normalize_declared_language("ja-JP") == "ja"
    assert detect_book_language("彼女は静かに本を開いた。これは小さな物語です。" * 4) == "ja"
    assert detect_book_language("这是一本用于测试语言识别的中文小说。" * 4) == "zh"
    assert detect_book_language("This is a sufficiently long English paragraph for language detection." * 2) == "en"


def test_chinese_translation_overrides_stale_japanese_epub_metadata() -> None:
    chinese_body = "这是中文译文，正文中的人物正在交谈，并继续讲述接下来的故事。" * 80

    assert detect_book_language(
        "秘密的二人同居～与奴隶少女的同居生活～",
        "テキらしゅ",
        chinese_body,
        declared_language="ja-JP",
    ) == "zh"


def test_japanese_metadata_without_japanese_prose_is_not_an_original() -> None:
    assert detect_book_language(
        "吸血王女バラハンドル・マクシミリアン",
        "みつえ",
        declared_language="ja",
    ) == "und"


def test_confirmed_japanese_prose_overrides_incorrect_declared_language() -> None:
    japanese_body = "彼女は窓の外を見つめながら、静かな声で昨日の出来事を話し始めた。" * 20

    assert detect_book_language(japanese_body, declared_language="zh-CN") == "ja"


@pytest.mark.parametrize(("declared", "expected"), [
    (" en_US ", "en"), ("eng-GB", "en"), ("zh-Hant-TW", "zh"), ("jpn-JP", "ja"),
    ("fr-FR", "other"), ("de", "other"), ("pt-BR", "other"), ("ko-KR", "other"),
    ("jam", "other"), ("zha", "other"), ("enm", "other"), ("enochian", "other"),
    ("und-Latn", None), ("mul", None), ("zxx", None), ("mis", None),
    ("", None), ("en-", None), ("ja/zh", None), ("x-en", None),
])
def test_normalizes_complete_language_subtags(declared: str, expected: str | None) -> None:
    assert normalize_declared_language(declared) == expected


@pytest.mark.parametrize(("language", "body"), [
    ("fr-FR", "Une lettre attendait dans la bibliothèque. Elle ouvrit doucement la fenêtre et regarda les étoiles. "),
    ("de-DE", "Sie öffnete das Buch und las die Geschichte eines langen Abends in der alten Bibliothek. "),
    ("nl-NL", "Het was een rustige avond in de bibliotheek. Ze keek naar de boeken en las een brief. "),
    ("es", "Ella abrió el libro y leyó una historia sobre una noche tranquila en la biblioteca. "),
])
def test_latin_prose_is_not_automatically_english(language: str, body: str) -> None:
    assert detect_book_language(body * 8, declared_language=language) == "other"
    assert detect_book_language(body * 8) == "und"


@pytest.mark.parametrize("body", [
    "Она открыла книгу и прочитала историю о тихом вечере в старой библиотеке. ",
    "그녀는 도서관에서 책을 펼치고 조용한 저녁에 편지를 읽으며 창문 밖을 바라보았다. ",
    "فتحت الكتاب في المكتبة وقرأت رسالة طويلة ثم نظرت من النافذة إلى السماء الهادئة. ",
])
def test_other_scripts_override_an_english_publisher_notice(body: str) -> None:
    text = body * 12 + "Copyright publisher, all rights reserved. " * 2
    assert detect_book_language(text) == "other"
    assert detect_book_language(text, declared_language="en") == "other"


@pytest.mark.parametrize("quotation", [
    "彼女は窓の外を見つめながら、静かな声で昨日の出来事を話し始めた。" * 2,
    "这是书里引用的一小段中文，不能决定整本外文小说的主要语言。" * 2,
])
def test_a_short_cjk_quotation_does_not_override_other_language_prose(quotation: str) -> None:
    french_body = "Une lettre attendait dans la bibliothèque. Elle ouvrit doucement la fenêtre et regarda les étoiles. " * 30
    assert detect_book_language(quotation, french_body, declared_language="fr") == "other"


def test_confident_prose_still_overrides_stale_metadata() -> None:
    chinese_body = "这是中文译文，正文中的人物正在交谈，并继续讲述接下来的故事。" * 80
    english_body = "She opened the book and read the letter. The story was waiting for her in the quiet library. " * 20
    assert detect_book_language(chinese_body, declared_language="fr") == "zh"
    assert detect_book_language(english_body, declared_language="zh") == "en"


def test_other_language_declaration_survives_empty_image_only_content() -> None:
    assert detect_book_language(declared_language="fr") == "other"
    assert detect_book_language(declared_language="und") == "und"


@pytest.mark.parametrize("address", [
    "https://example.test/the/book/and/the/library ",
    "www.example.test/with/her/and/the/book ",
    "the.and.with.her@example.test ",
])
def test_addresses_do_not_count_as_english_prose(address: str) -> None:
    assert detect_book_language(address * 8) == "und"


@pytest.mark.parametrize(("declared", "body", "expected"), [
    ("fr-FR", "Une lettre attendait dans la bibliothèque. Elle regardait les étoiles du soir. ", "other"),
    ("und", "Une lettre attendait dans la bibliothèque. Elle regardait les étoiles du soir. ", "und"),
    ("en-GB", "She opened the book and read the letter. The story was waiting for her in the quiet library. ", "en"),
    ("enm", "She opened the book and read the letter. The story was waiting for her in the quiet library. ", "other"),
    ("ja-JP", "彼女は窓の外を見つめながら、静かな声で昨日の出来事を話し始めた。", "ja"),
    ("zh-CN", "这是中文译文，正文中的人物正在交谈，并继续讲述接下来的故事。", "zh"),
    ("ja-JP", "这是中文译文，正文中的人物正在交谈，并继续讲述接下来的故事。", "zh"),
    ("fr-FR", "彼女は窓の外を見つめながら、静かな声で昨日の出来事を話し始めた。", "ja"),
])
def test_epub_upload_persists_detected_language_without_changing_prose(
    client: TestClient, auth_headers: dict[str, str], declared: str, body: str, expected: str,
) -> None:
    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr("META-INF/container.xml", '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
        archive.writestr("book.opf", f'<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Library letter</dc:title><dc:creator>Author</dc:creator><dc:language>{declared}</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>')
        archive.writestr("chapter.xhtml", f'<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter 1</h1><p>{escape(body * 12)}</p></body></html>')
    upload = client.post("/api/v1/uploads/books", headers=auth_headers, files={"file": ("language.epub", buffer.getvalue(), "application/epub+zip")})
    assert upload.status_code == 200
    book_id = upload.json()["book_id"]
    book = client.get(f"/api/v1/books/{book_id}", headers=auth_headers)
    assert book.status_code == 200
    assert book.json()["status"] == "ready"
    assert book.json()["language"] == expected
    chapter = client.get(f"/api/v1/books/{book_id}/reader/chapters/1", headers=auth_headers)
    assert chapter.status_code == 200
    assert body.strip() in chapter.json()["content"]


def test_filters_book_list_by_language() -> None:
    response = list_books(
        owner_id="owner",
        book_repository=InMemoryBookRepository([make_book("ja-book", "ja"), make_book("zh-book", "zh")]),
        progress_repository=InMemoryReadingProgressRepository(),
        q=None,
        kind=None,
        tag=None,
        language="ja",
        sort="recent",
        page=1,
        page_size=24,
    )

    assert [book.id for book in response.items] == ["ja-book"]
    assert response.items[0].language == "ja"
