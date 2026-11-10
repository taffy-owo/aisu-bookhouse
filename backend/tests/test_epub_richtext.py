from app.modules.processing.processors.epub_richtext import extract_chapter_blocks


def test_extract_chapter_blocks_preserves_marks_ruby_and_heading() -> None:
    document = (
        "<html><body>"
        "<h2>第二章 <strong>觉醒</strong></h2>"
        "<p>他<strong>用力</strong>握紧了<em>拳头</em>，"
        "<ruby><rb>漢字</rb><rt>かんじ</rt></ruby>浮现。</p>"
        "</body></html>"
    ).encode("utf-8")

    blocks = extract_chapter_blocks(document)

    heading = blocks[0]
    assert heading["type"] == "heading"
    assert heading["level"] == 2
    assert heading["text"] == "第二章 觉醒"
    assert {"text": "觉醒", "marks": ["strong"], "ruby": None} in heading["spans"]

    paragraph = blocks[1]
    assert paragraph["type"] == "paragraph"
    assert paragraph["text"] == "他用力握紧了拳头，漢字浮现。"
    spans = paragraph["spans"]
    assert {"text": "用力", "marks": ["strong"], "ruby": None} in spans
    assert {"text": "拳头", "marks": ["emphasis"], "ruby": None} in spans
    assert {"text": "漢字", "marks": [], "ruby": "かんじ"} in spans


def test_extract_chapter_blocks_reads_bare_ruby_base() -> None:
    document = "<html><body><p><ruby>東京<rt>とうきょう</rt></ruby>タワー</p></body></html>".encode("utf-8")

    blocks = extract_chapter_blocks(document)

    assert blocks[0]["text"] == "東京タワー"
    assert blocks[0]["spans"][0] == {"text": "東京", "marks": [], "ruby": "とうきょう"}


def test_extract_chapter_blocks_detects_emphasis_dots() -> None:
    document = (
        '<html><body><p>这是<em class="emphasis-dot">重点</em>内容，'
        '<span style="text-emphasis: filled dot">强调</span>。</p></body></html>'
    ).encode("utf-8")

    blocks = extract_chapter_blocks(document)

    spans = blocks[0]["spans"]
    assert {"text": "重点", "marks": ["emphasis_dot"], "ruby": None} in spans
    assert {"text": "强调", "marks": ["emphasis_dot"], "ruby": None} in spans


def test_extract_chapter_blocks_emits_image_blocks_for_known_images() -> None:
    document = (
        "<html><body><p>前文</p>"
        '<img src="images/pic.png"/>'
        '<img src="images/unknown.png"/>'
        '<img src="data:image/png;base64,AAAA"/>'
        "<p>后文</p></body></html>"
    ).encode("utf-8")

    blocks = extract_chapter_blocks(document, "OPS/chapter-1.xhtml", {"OPS/images/pic.png": 3})

    assert [block["type"] for block in blocks] == ["paragraph", "image", "paragraph"]
    assert blocks[1] == {"type": "image", "image_index": 3}


def test_extract_chapter_blocks_without_markers_drops_all_images() -> None:
    document = '<html><body><p>前文</p><img src="images/pic.png"/><p>后文</p></body></html>'.encode("utf-8")

    blocks = extract_chapter_blocks(document, "OPS/chapter-1.xhtml", None)

    assert [block["type"] for block in blocks] == ["paragraph", "paragraph"]


def test_extract_chapter_blocks_strips_scripts_and_dangerous_markup() -> None:
    document = (
        "<html><body>"
        '<script>alert("xss")</script>'
        '<style>p{color:red}</style>'
        '<p onclick="steal()">安全<a href="javascript:evil()">链接</a>文本</p>'
        '<img src="x" onerror="alert(1)"/>'
        "</body></html>"
    ).encode("utf-8")

    blocks = extract_chapter_blocks(document, "OPS/c.xhtml", {})

    assert len(blocks) == 1
    paragraph = blocks[0]
    assert paragraph["type"] == "paragraph"
    # The anchor's href/onclick and the script/style bodies never surface —
    # only whitelisted plain text remains, with no rich spans.
    assert paragraph["text"] == "安全链接文本"
    assert "spans" not in paragraph
    joined = " ".join(str(block.get("text", "")) for block in blocks)
    assert "alert" not in joined
    assert "javascript" not in joined
    assert "color" not in joined


def test_extract_chapter_blocks_treats_plain_em_as_emphasis_not_dot() -> None:
    document = '<html><body><p><em>斜体</em>与<em class="emphasis">强调</em></p></body></html>'.encode("utf-8")

    blocks = extract_chapter_blocks(document)

    spans = blocks[0]["spans"]
    # A bare <em> and a generic class="emphasis" are italic emphasis, not dots.
    assert {"text": "斜体", "marks": ["emphasis"], "ruby": None} in spans
    assert {"text": "强调", "marks": ["emphasis"], "ruby": None} in spans


def test_extract_chapter_blocks_splits_line_breaks_into_paragraphs() -> None:
    document = "<html><body><p>第一行<br/>第二行</p></body></html>".encode("utf-8")

    blocks = extract_chapter_blocks(document)

    assert [block["text"] for block in blocks] == ["第一行", "第二行"]
