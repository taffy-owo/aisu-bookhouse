from app.modules.book_assets.image_metadata import image_reference_looks_like_inline_icon


def test_large_named_note_decoration_is_not_treated_as_an_illustration() -> None:
    assert image_reference_looks_like_inline_icon(
        pixel_width=855,
        pixel_height=346,
        source="OEBPS/Images/note3.webp",
    )


def test_large_real_illustration_is_preserved() -> None:
    assert not image_reference_looks_like_inline_icon(
        pixel_width=4096,
        pixel_height=3212,
        source="OEBPS/Images/kuchie-002.webp",
    )


def test_decoration_name_must_match_the_complete_filename_stem() -> None:
    assert not image_reference_looks_like_inline_icon(
        pixel_width=1443,
        pixel_height=2048,
        source="OEBPS/Images/notebook-girl.webp",
    )
