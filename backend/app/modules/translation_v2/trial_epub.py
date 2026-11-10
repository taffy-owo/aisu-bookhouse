"""Build an explicitly labelled, text-only trial EPUB; never overwrite a book."""
from datetime import datetime, timezone
from html import escape
from io import BytesIO
import posixpath
from urllib.parse import unquote, urlsplit
from uuid import NAMESPACE_URL, uuid5
from xml.etree import ElementTree as ET
from zipfile import ZipFile, ZIP_DEFLATED, ZIP_STORED

from app.modules.processing.processors.epub_richtext import extract_chapter_blocks
from .pilot import Draft, TrialError, digest, plain


TITLE = '爱素书屋·翻译流程实测节选'
CSS = '''body{font-family:serif;line-height:1.85;margin:5%;}h1{font-size:1.4em;}
p{margin:0 0 1em;text-indent:2em;} .titlepage{text-align:center;padding-top:15%;}
.titlepage p{text-indent:0;} .dialogue{text-indent:0;}'''


def xhtml(title: str, body: str) -> str:
    return ('<?xml version="1.0" encoding="UTF-8"?>'
            '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" '
            'xml:lang="zh-CN" lang="zh-CN"><head><meta charset="UTF-8"/>'
            f'<title>{escape(title)}</title><link rel="stylesheet" href="style.css"/></head><body>{body}</body></html>')


def build_trial_epub(draft: Draft, source_url: str) -> bytes:
    if not draft.blocks:
        raise TrialError('empty_epub')
    identifier = 'urn:uuid:' + str(uuid5(NAMESPACE_URL, source_url + digest(draft.model_dump())))
    date = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    paragraphs = []
    for block in draft.blocks:
        content = ''.join(escape(s.text.lstrip(' \u3000') if i == 0 else s.text)
                          + ('<br/>' if s.break_after == 'line' and i < len(block.segments) - 1 else '')
                          for i, s in enumerate(block.segments))
        cls = ' class="dialogue"' if plain(block).lstrip().startswith(('「', '『')) else ''
        paragraphs.append(f'<p id="{escape(block.block_id, quote=True)}"{cls}>{content}</p>')
    documents = {
        'mimetype': 'application/epub+zip',
        'META-INF/container.xml': '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        'OEBPS/style.css': CSS,
        'OEBPS/title.xhtml': xhtml(TITLE, '<section class="titlepage"><h1>' + TITLE + '</h1><p>ころね 著</p><p>普通生活叙事节选 · 流程测试 · 非完整章节</p></section>'),
        'OEBPS/sample.xhtml': xhtml('生活叙事节选', '<article><h1>生活叙事节选</h1>' + ''.join(paragraphs) + '</article>'),
        'OEBPS/nav.xhtml': xhtml('目录', '<nav epub:type="toc" id="toc"><h1>目录</h1><ol><li><a href="title.xhtml">测试说明</a></li><li><a href="sample.xhtml">生活叙事节选</a></li></ol></nav>'),
        'OEBPS/toc.ncx': f'<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="{identifier}"/></head><docTitle><text>{TITLE}</text></docTitle><navMap><navPoint id="n1" playOrder="1"><navLabel><text>测试说明</text></navLabel><content src="title.xhtml"/></navPoint><navPoint id="n2" playOrder="2"><navLabel><text>生活叙事节选</text></navLabel><content src="sample.xhtml"/></navPoint></navMap></ncx>',
        'OEBPS/content.opf': f'''<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0" xml:lang="zh-CN">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">{identifier}</dc:identifier>
<dc:title>{TITLE}</dc:title><dc:creator>ころね</dc:creator><dc:language>zh-CN</dc:language>
<dc:source>{escape(source_url)}</dc:source><meta property="dcterms:modified">{date}</meta></metadata>
<manifest><item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
<item id="sample" href="sample.xhtml" media-type="application/xhtml+xml"/>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/></manifest>
<spine toc="ncx"><itemref idref="title"/><itemref idref="sample"/></spine></package>''',
    }
    buffer = BytesIO()
    with ZipFile(buffer, 'w') as archive:
        for name, content in documents.items():
            archive.writestr(name, content.encode('utf-8'), compress_type=ZIP_STORED if name == 'mimetype' else ZIP_DEFLATED)
    return buffer.getvalue()


def validate_trial_epub(data: bytes, draft: Draft) -> dict:
    with ZipFile(BytesIO(data)) as archive:
        info = archive.infolist()[0]
        if info.filename != 'mimetype' or info.compress_type != ZIP_STORED or archive.read('mimetype') != b'application/epub+zip':
            raise TrialError('epub_mimetype')
        if archive.testzip() is not None or len(set(archive.namelist())) != len(archive.namelist()):
            raise TrialError('epub_zip_integrity')
        docs = {n: ET.fromstring(archive.read(n)) for n in archive.namelist() if n.endswith(('.xml', '.opf', '.ncx', '.xhtml'))}
        for path, root in docs.items():
            for node in root.iter():
                for attr in ('href', 'src'):
                    if attr not in node.attrib:
                        continue
                    url = urlsplit(node.attrib[attr])
                    if url.scheme:
                        continue
                    target = posixpath.normpath(posixpath.join(posixpath.dirname(path), unquote(url.path))) if url.path else path
                    if target not in archive.namelist():
                        raise TrialError('epub_missing_resource')
        opf = docs['OEBPS/content.opf']
        ns = {'o': 'http://www.idpf.org/2007/opf'}
        ids = [item.get('id') for item in opf.findall('o:manifest/o:item', ns)]
        if len(ids) != len(set(ids)) or any(item.get('idref') not in ids for item in opf.findall('o:spine/o:itemref', ns)):
            raise TrialError('epub_spine')
        extracted = extract_chapter_blocks(archive.read('OEBPS/sample.xhtml'))
        paragraphs = [b['text'] for b in extracted if b['type'] == 'paragraph']
        expected = [plain(b).strip() for b in draft.blocks]
        if paragraphs != expected:
            raise TrialError('epub_reader_roundtrip', expected_count=len(expected), actual_count=len(paragraphs))
        return {'zip_crc': 'passed', 'xml': 'passed', 'resources': 'passed', 'spine': 'passed',
                'reader_roundtrip': 'passed', 'paragraphs': len(paragraphs), 'epubcheck': 'not_run'}
