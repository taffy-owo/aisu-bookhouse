from pathlib import Path


AUXILIARY_SOURCE_STEMS = {
    "cover",
    "title",
    "toc",
    "nav",
    "contents",
    "copyright",
    "colophon",
}


def is_auxiliary_text_metadata(metadata: dict[str, object]) -> bool:
    # An explicit editor chapter stays readable even when its chosen title
    # resembles imported front matter. The flag also survives EPUB reprocessing.
    if metadata.get("content_is_body") is True:
        return False
    source = metadata.get("source")
    if isinstance(source, str) and source != "manual_append":
        source_stem = Path(source.replace("\\", "/")).stem.strip().lower()
        if source_stem in AUXILIARY_SOURCE_STEMS:
            return True

    title = metadata.get("title")
    if not isinstance(title, str):
        return metadata.get("is_auxiliary") is True

    image_count = metadata.get("image_count")
    if is_non_reading_auxiliary_title(title):
        return True
    if metadata.get("is_auxiliary") is True:
        return True
    if isinstance(image_count, int) and image_count > 0 and is_illustration_title(title):
        return False

    return is_auxiliary_title(title)


def is_auxiliary_title(title: str) -> bool:
    return is_non_reading_auxiliary_title(title) or is_illustration_title(title)


def is_non_reading_auxiliary_title(title: str) -> bool:
    compact_title = title.strip().replace(" ", "").replace("　", "").lower()

    return compact_title in {
        "cover",
        "title",
        "copyright",
        "contents",
        "credits",
        "staff",
        "tableofcontents",
        "illustration",
        "illustrations",
        "封面",
        "封面页",
        "扉页",
        "扉頁",
        "题名页",
        "題名頁",
        "標題",
        "标题",
        "版权",
        "版權",
        "版权信息",
        "版權資訊",
        "作品信息",
        "作品資訊",
        "制作信息",
        "製作資訊",
        "制作人员",
        "製作人員",
        "目录",
        "目錄",
        "简介",
        "簡介",
        "内容简介",
        "內容簡介",
        "人物介绍",
        "人物介紹",
    }


def is_illustration_title(title: str) -> bool:
    compact_title = title.strip().replace(" ", "").replace("　", "").lower()

    return compact_title in {
        "illustration",
        "illustrations",
        "彩页",
        "彩頁",
        "插图",
        "插圖",
        "插画",
        "插畫",
    }

