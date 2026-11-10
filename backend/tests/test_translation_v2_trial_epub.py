from app.modules.translation_v2.pilot import Draft, Segment, TargetBlock
from app.modules.translation_v2.trial_epub import build_trial_epub, validate_trial_epub


def test_epub_reader_roundtrip_preserves_dialogue_and_paragraphs():
    draft = Draft(blocks=[TargetBlock(block_id='p1', segments=[Segment(text='窗外下着雨。', break_after='none')]),
                         TargetBlock(block_id='p2', segments=[Segment(text='「回家吧。」', break_after='none')])])
    data = build_trial_epub(draft, 'https://example.test/work')
    result = validate_trial_epub(data, draft)
    assert result['reader_roundtrip'] == 'passed'
    assert result['paragraphs'] == 2
