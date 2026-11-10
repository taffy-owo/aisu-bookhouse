from xml.etree import ElementTree

from app.modules.processing.processors.epub_processor import extract_chapter_text, read_epub_metadata


def test_read_epub_metadata_cleans_html_description() -> None:
    opf_root = ElementTree.fromstring(
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0">'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
        '<dc:title>Test Book</dc:title>'
        '<dc:creator>Test Author</dc:creator>'
        '<dc:language>ja-JP</dc:language>'
        '<dc:description>&lt;p&gt;First&amp;nbsp;paragraph&lt;/p&gt;&lt;p&gt;Second&lt;br/&gt;line&lt;/p&gt;</dc:description>'
        '</metadata>'
        '</package>'
    )

    metadata = read_epub_metadata(opf_root)

    assert metadata["description"] == "First paragraph\nSecond\nline"
    assert metadata["language"] == "ja-JP"


def test_read_epub_metadata_reads_epub3_meta_description() -> None:
    opf_root = ElementTree.fromstring(
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0">'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
        '<dc:title>Test Book</dc:title>'
        '<meta property="dcterms:description">EPUB3 description text</meta>'
        '</metadata>'
        '</package>'
    )

    metadata = read_epub_metadata(opf_root)

    assert metadata["description"] == "EPUB3 description text"


def test_read_epub_metadata_reads_meta_description_content_attribute() -> None:
    opf_root = ElementTree.fromstring(
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0">'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
        '<dc:title>Test Book</dc:title>'
        '<meta name="description" content="Content attribute description" />'
        '</metadata>'
        '</package>'
    )

    metadata = read_epub_metadata(opf_root)

    assert metadata["description"] == "Content attribute description"


def test_extract_chapter_text_ignores_head_title() -> None:
    document = (
        b'<html><head><title>Chapter Title</title></head>'
        b'<body><h1>Chapter Title</h1><p>Body starts here.</p></body></html>'
    )

    assert extract_chapter_text(document) == "Chapter Title\n\nBody starts here."
