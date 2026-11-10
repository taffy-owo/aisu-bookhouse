import asyncio
from copy import deepcopy
import pytest
from app.modules.translation_v2.pilot import SourceBlock, TargetBlock, Segment, Draft, Review, Finding, TrialError, verified_review, verified_block_output


def example():
    source = [SourceBlock(block_id='title', text='帰宅'), SourceBlock(block_id='p1', text='家に帰った。')]
    target = Draft(blocks=[TargetBlock(block_id=b.block_id, segments=[Segment(text=t, break_after='none')]) for b,t in zip(source,['回家','她回家了。'])])
    return source, target, {'source_blocks':[b.model_dump() for b in source], 'candidate':target.model_dump()}


class Client:
    def __init__(self, responses):
        self.responses, self.payloads = iter(responses), []
    async def call(self, stage, payload, schema):
        self.payloads.append(deepcopy(payload))
        result = next(self.responses)
        if isinstance(result,Exception):
            raise result
        return result


def test_missing_title_is_actually_reviewed_not_filled_in():
    source, target, payload = example()
    client = Client([Review(checked_block_ids=['p1'],findings=[]), Review(checked_block_ids=['title'],findings=[])])
    result = asyncio.run(verified_review(client,payload,source,target))
    assert result.checked_block_ids == ['title','p1']
    assert [b['block_id'] for b in client.payloads[1]['source_blocks']] == ['title']
    assert [b['block_id'] for b in client.payloads[1]['candidate']['blocks']] == ['title']
    assert 'validation_feedback' in client.payloads[1]


def test_repeated_missing_coverage_still_fails_after_two_corrections():
    source,target,payload = example()
    client = Client([Review(checked_block_ids=['p1'],findings=[]), Review(checked_block_ids=[],findings=[]), Review(checked_block_ids=[],findings=[])])
    with pytest.raises(TrialError,match='coverage'):
        asyncio.run(verified_review(client,payload,source,target))
    assert len(client.payloads) == 3


def test_reordered_complete_checklist_does_not_call_model_again():
    source,target,payload = example()
    client = Client([Review(checked_block_ids=['p1','title'],findings=[])])
    assert asyncio.run(verified_review(client,payload,source,target)).checked_block_ids == ['title','p1']
    assert len(client.payloads) == 1


def test_partial_review_with_invalid_evidence_must_be_rechecked():
    source,target,payload = example()
    bad = Finding(block_id='p1',severity='major',code='claim',source_quote='不存在',target_quote='',explanation='wrong evidence')
    client = Client([Review(checked_block_ids=['p1'],findings=[bad]), Review(checked_block_ids=['title','p1'],findings=[])])
    result = asyncio.run(verified_review(client,payload,source,target))
    assert result.findings == []
    assert len(client.payloads[1]['source_blocks']) == 2


def test_new_major_finding_is_not_discarded_when_filling_gap():
    source,target,payload = example()
    finding = Finding(block_id='title',severity='major',code='title_error',source_quote='帰宅',target_quote='回家',explanation='Review finding remains visible')
    client = Client([Review(checked_block_ids=['p1'],findings=[]), Review(checked_block_ids=['title'],findings=[finding])])
    result = asyncio.run(verified_review(client,payload,source,target))
    assert result.findings == [finding]


def test_missing_draft_title_generated_once_with_source_context():
    source,target,payload = example()
    client = Client([Draft(blocks=target.blocks[1:]),Draft(blocks=target.blocks[:1])])
    result = asyncio.run(verified_block_output(client,'draft',payload,Draft,source))
    assert result == target
    assert client.payloads[1]['source_blocks'] == payload['source_blocks'][:1]
    assert client.payloads[1]['read_only_source_context'] == payload['source_blocks']


def test_duplicate_draft_ids_are_not_silently_dropped():
    source,target,payload = example()
    client = Client([Draft(blocks=[target.blocks[1],target.blocks[1]]),target])
    assert asyncio.run(verified_block_output(client,'draft',payload,Draft,source)) == target
    assert len(client.payloads[1]['source_blocks']) == 2


def test_missing_draft_is_bounded_and_cannot_publish_empty_blocks():
    source,target,payload = example()
    client = Client([Draft(blocks=[])]*3)
    with pytest.raises(TrialError,match='coverage'):
        asyncio.run(verified_block_output(client,'draft',payload,Draft,source))
    assert len(client.payloads) == 3


def test_truncated_review_is_split_with_context_and_real_coverage():
    source,target,payload = example()
    client = Client([TrialError('truncated_output'),Review(checked_block_ids=['title'],findings=[]),Review(checked_block_ids=['p1'],findings=[])])
    result = asyncio.run(verified_review(client,payload,source,target))
    assert result.checked_block_ids == ['title','p1']
    assert client.payloads[1]['read_only_source_context'] == payload['source_blocks']
    assert client.payloads[2]['read_only_candidate_context'] == payload['candidate']


def test_truncated_draft_is_split_without_splitting_paragraphs():
    source,target,payload = example()
    client = Client([TrialError('truncated_output'),Draft(blocks=target.blocks[:1]),Draft(blocks=target.blocks[1:])])
    assert asyncio.run(verified_block_output(client,'draft',payload,Draft,source)) == target
    assert client.payloads[1]['source_blocks'] == payload['source_blocks'][:1]


def test_single_block_truncation_cannot_be_claimed_successful():
    source,target,payload = example()
    client = Client([TrialError('truncated_output')])
    with pytest.raises(TrialError,match='truncated'):
        asyncio.run(verified_review(client,payload,source[:1],Draft(blocks=target.blocks[:1])))
    assert len(client.payloads) == 1


def test_invalid_quote_rechecks_only_affected_block_and_retains_confirmed_findings():
    source, target, payload = example()
    valid = Finding(block_id='title', severity='major', code='title_error', source_quote='帰宅',
        target_quote='回家', explanation='Confirmed finding must survive corrective review')
    invalid = Finding(block_id='p1', severity='major', code='claim', source_quote='不存在',
        target_quote='', explanation='Unverified evidence')
    payload['unresolved_findings'] = [valid.model_dump()]
    client = Client([Review(checked_block_ids=['title', 'p1'], findings=[valid, invalid]),
        Review(checked_block_ids=['p1'], findings=[])])
    result = asyncio.run(verified_review(client, payload, source, target))
    assert result.checked_block_ids == ['title', 'p1'] and result.findings == [valid]
    correction = client.payloads[1]
    assert correction['source_blocks'] == payload['source_blocks'][1:]
    assert correction['candidate']['blocks'] == payload['candidate']['blocks'][1:]
    assert correction['read_only_source_context'] == payload['source_blocks']
    assert correction['read_only_candidate_context'] == payload['candidate']
    assert correction['validation_feedback']['invalid_findings'] == [invalid.model_dump()]
    assert correction['unresolved_findings'] == []


def test_repeated_invalid_target_quote_is_bounded_and_never_accepted():
    source, target, payload = example()
    invalid = Finding(block_id='p1', severity='major', code='claim', source_quote='家に帰った。',
        target_quote='她没有回家。', explanation='Wrong target quote')
    client = Client([Review(checked_block_ids=['title', 'p1'], findings=[invalid]),
        Review(checked_block_ids=['p1'], findings=[invalid]),
        Review(checked_block_ids=['p1'], findings=[invalid])])
    with pytest.raises(TrialError, match='review_invalid_target_quote'):
        asyncio.run(verified_review(client, payload, source, target))
    assert len(client.payloads) == 3


def test_valid_finding_on_same_block_survives_bad_quote_correction():
    source, target, payload = example()
    valid = Finding(block_id='p1', severity='major', code='subject', source_quote='家に帰った。',
        target_quote='她回家了。', explanation='Confirmed issue')
    invalid = valid.model_copy(update={'source_quote': '不存在', 'code': 'bad_evidence'})
    client = Client([Review(checked_block_ids=['title', 'p1'], findings=[valid, invalid]),
        Review(checked_block_ids=['p1'], findings=[])])
    assert asyncio.run(verified_review(client, payload, source, target)).findings == [valid]
