from app.modules.processing.processors.txt_processor import MAX_TXT_CHAPTER_CHARS, split_chapters
import pytest


@pytest.mark.parametrize("opening", [
    "第十二章的线索并不在书页上，而在信里。", "第十二章已经结束。", "第十二章里没有她的名字",
    "序章结束后，她还在等那封信。", "番外的故事还没结束。",
])
def test_txt_keeps_heading_like_prose_in_the_body(opening: str) -> None:
    body = f"{opening}\n\n第二段保留。"
    assert split_chapters(body) == [{"title": "第 1 章", "content": body}]


def test_txt_recognizes_spaced_fullwidth_compact_and_sentence_titles_together() -> None:
    headings = ["第 1 章 开始", "第２話：来信", "第三章雪夜", "第四章 她来了，为什么又走了！？", "Chapter 5: A letter"]
    text = "\n\n".join(f"{title}\n\n正文{index}。" for index, title in enumerate(headings, 1))
    chapters = split_chapters(text)
    assert [chapter["title"] for chapter in chapters] == headings
    assert all(f"正文{index}。" in chapter["content"] for index, chapter in enumerate(chapters, 1))


def test_txt_split_chapters_accepts_indented_titles() -> None:
    chapters = split_chapters("楔子\n\n  第一章 启程\n正文一\n\n\t第二章 抵达\n正文二")

    assert [chapter["title"] for chapter in chapters] == ["序章", "第一章 启程", "第二章 抵达"]
    assert chapters[1]["content"].startswith("第一章 启程")


def test_txt_split_chapters_chunks_single_large_body() -> None:
    chapters = split_chapters("很长的正文。" * 2200)

    assert len(chapters) > 1
    assert chapters[0]["title"] == "第 1 章 (1)"
    assert chapters[1]["title"] == "第 1 章 (2)"
    assert all(len(chapter["content"]) <= MAX_TXT_CHAPTER_CHARS for chapter in chapters)


def test_txt_split_chapters_chunks_oversized_matched_chapter() -> None:
    chapters = split_chapters("第一章 巨大的章节\n" + ("内容。" * 4000))

    assert len(chapters) > 1
    assert chapters[0]["title"] == "第一章 巨大的章节 (1)"
    assert chapters[1]["title"] == "第一章 巨大的章节 (2)"


def test_txt_split_chapters_ignores_a_catalogue_block() -> None:
    # Scraped exports list every episode under 目录 before the body starts, and
    # those entries match CHAPTER_PATTERN exactly as well as the real headings
    # do. Each one used to open a chapter holding nothing but itself.
    text = (
        "作者:某人\n\n目录\n"
        "第一话 启程\n\n"
        "第二话 抵达\n\n"
        "----------\n\n"
        "第一话 【启程】\n正文一。\n\n"
        "第二话 【抵达】\n正文二。\n"
    )

    chapters = split_chapters(text)

    assert [chapter["title"] for chapter in chapters] == ["序章", "第一话 【启程】", "第二话 【抵达】"]
    # The 目录 label itself is not a heading, so it stays with the front matter.
    assert chapters[0]["content"] == "作者:某人\n\n目录"
    assert "正文一。" in chapters[1]["content"]
    assert "正文二。" in chapters[2]["content"]


def test_txt_split_chapters_keeps_a_heading_separated_from_its_body_by_a_rule() -> None:
    # A divider between heading and prose is decoration, not an empty chapter.
    chapters = split_chapters("第一章 启程\n\n──────\n\n正文一。\n")

    assert [chapter["title"] for chapter in chapters] == ["第一章 启程"]
    assert "正文一。" in chapters[0]["content"]


def test_txt_split_chapters_falls_back_when_every_heading_is_bare() -> None:
    # A file that is nothing but a listing still has to yield something.
    chapters = split_chapters("目录\n第一话 启程\n\n第二话 抵达\n")

    assert len(chapters) == 1
    assert chapters[0]["title"] == "第 1 章"
