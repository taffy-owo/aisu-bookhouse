from app.modules.books.chapter_append import normalize_appended_chapter
import pytest


@pytest.mark.parametrize("opening", [
    "第十二章的线索并不在书页上，而在信里。",
    "第十二章已经结束。",
    "第十二章里没有她的名字",
    "第三次读完这本书，我才留意到章节之间的联系。",
    "序章结束后，她还在等那封信。",
    "番外的故事还没结束。",
    "后记里提到的地点就是这里。",
    "第十二章 " + "这是一段很长的正文" * 35 + "。",
])
def test_append_keeps_narrative_opening_with_or_without_explicit_title(opening: str) -> None:
    body = f"{opening}\n\n第二段保留。"
    assert normalize_appended_chapter(None, body, 2) == ("第 2 章", body)
    assert normalize_appended_chapter("第一话 灯下的来信", body, 2) == ("第一话 灯下的来信", body)


@pytest.mark.parametrize("heading", [
    "第 12 章 再会", "第一章雪夜", "第１０話", "第两百章：归途",
    "第十二章 她来了，为什么又走了！？", "第１２話「夜雨」",
    "序章", "序章 夜色", "後記：写在最后", "番外一 夜雨",
    "Chapter 12: A letter", "Chapter１２ A letter", "Extra: A rainy night",
])
def test_append_still_detects_clear_chapter_headers(heading: str) -> None:
    assert normalize_appended_chapter(None, f"{heading}\n\n第一段。\n第二段。", 2) == (heading, "第一段。\n\n第二段。")


def test_append_does_not_extract_another_title_from_an_already_prepared_body() -> None:
    body = "第 2 章 夜雨\n\n她把这一行又念了一次。"
    assert normalize_appended_chapter("第 2 章 夜雨", body, 2, content_is_body=True) == ("第 2 章 夜雨", body)


def test_normalize_appended_chapter_extracts_title_and_formats_single_line_paragraphs() -> None:
    title, content = normalize_appended_chapter(
        None,
        "\ufeff第 12 章 再会\r\n　第一段。  \r\n\u200b第二段！",
        12,
    )

    assert title == "第 12 章 再会"
    assert content == "第一段。\n\n第二段！"


def test_normalize_appended_chapter_removes_repeated_explicit_title() -> None:
    title, content = normalize_appended_chapter("第十三章 夜色", "第十三章 夜色\n正文。", 13)

    assert title == "第十三章 夜色"
    assert content == "正文。"


def test_normalize_appended_chapter_joins_hard_wrapped_lines() -> None:
    wrapped = "\n".join(
        [
            "这是一段从排版文档复制出来的很长正文，因为原页面栏宽有限所以这里被强制换行",
            "换行处并不代表新的段落，前后内容应当保持连续并在整理后重新接回同一个段落",
            "这种文本的多数行长度相近，而且行尾通常没有句号，因此可以稳定识别为硬换行",
            "最后一行会比其他行稍短。",
        ]
    )

    _, content = normalize_appended_chapter(None, wrapped, 1)

    assert "\n" not in content
    assert "强制换行换行处" in content


def test_normalize_appended_chapter_preserves_blank_separated_paragraphs() -> None:
    _, content = normalize_appended_chapter(None, "第一段。\n\n\n第二段。", 1)

    assert content == "第一段。\n\n第二段。"


def test_normalize_appended_chapter_repairs_full_width_space_blank_lines() -> None:
    title, content = normalize_appended_chapter(
        "第 10 章",
        "第１０話\n　　\n　　第一段。\n　　\n「第二段！」",
        10,
    )

    assert title == "第 10 章"
    assert content == "第一段。\n\n「第二段！」"


def test_normalize_edited_chapter_keeps_body_that_looks_like_a_heading() -> None:
    from app.modules.books.chapter_append import normalize_edited_chapter
    body = "第十二章的线索并不在书页上，而在信里。\n\n[[AISU_CHAPTER_IMAGE:1]]\n\n第二段保留。"
    title, content = normalize_edited_chapter("第一话 灯下的来信", body, 1)
    assert title == "第一话 灯下的来信"
    assert content == body


def test_normalize_edited_chapter_keeps_spacing_without_automatic_reflow() -> None:
    from app.modules.books.chapter_append import normalize_edited_chapter
    body = "　第一段。\r\n\r\n\r\n  第二段。  "
    assert normalize_edited_chapter("第 1 章", body, 1)[1] == body.replace("\r\n", "\n")


def test_normalize_edited_chapter_rejects_empty_body() -> None:
    import pytest
    from fastapi import HTTPException
    from app.modules.books.chapter_append import normalize_edited_chapter
    with pytest.raises(HTTPException) as error:
        normalize_edited_chapter("第 1 章", "　 \n", 1)
    assert error.value.status_code == 400
