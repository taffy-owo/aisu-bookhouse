import asyncio

import pytest

from app.modules.translation_v2.pilot import (
    Analysis, AnalysisBlock, Draft, Finding, Patch, Patches, Review, Segment,
    SourceBlock, TargetBlock, TrialClient, TrialError, apply_patches, check_review,
    digest, exact_ids, run_trial, save_json,
)


def block(text="她走回家。"):
    return TargetBlock(block_id="p1", segments=[Segment(text=text, break_after="none")])


def test_same_count_wrong_ids_is_not_coverage():
    with pytest.raises(TrialError, match="coverage"):
        exact_ids(["p1", "p1"], ["p1", "p2"])


def test_stale_patch_preserves_original():
    draft = Draft(blocks=[block()])
    changes = Patches(patches=[Patch(block_id="p1", base_hash="old", replacement_segments=[
        Segment(text="她笑了。", break_after="none")], reason="编辑")])
    with pytest.raises(TrialError, match="version_conflict"):
        apply_patches(draft, changes)
    assert draft.blocks[0].segments[0].text == "她走回家。"


def test_duplicate_patch_rejected():
    original = block()
    patch = Patch(block_id="p1", base_hash=digest(original.model_dump()),
                  replacement_segments=original.segments, reason="保持")
    with pytest.raises(TrialError, match="identity"):
        apply_patches(Draft(blocks=[original]), Patches(patches=[patch, patch]))


def test_review_requires_actual_evidence():
    review = Review(checked_block_ids=["p1"], findings=[Finding(
        block_id="p1", severity="major", code="added_action", source_quote="原文没有的句子",
        target_quote="", explanation="不可靠指控")])
    with pytest.raises(TrialError, match="source_quote"):
        check_review(review, [SourceBlock(block_id="p1", text="家に帰った。")], Draft(blocks=[block()]))


class FakeClient:
    def __init__(self, root, review):
        self.root, self.events, self.review = root, [], review

    async def call(self, stage, payload, schema):
        self.events.append({"stage": stage})
        if stage in ("edit", "proofread"):
            assert payload["source_blocks"][0]["text"] == "家に帰った。"
        if stage == "analysis":
            return Analysis(blocks=[AnalysisBlock(block_id="p1", speaker=None,
                implied_subject=None, facts=["回家"], uncertainties=[])])
        if stage == "draft":
            return Draft(blocks=[block()])
        if stage in ("edit", "proofread", "repair"):
            return Patches(patches=[])
        return self.review


def test_empty_review_is_not_success(tmp_path):
    client = FakeClient(tmp_path, Review(checked_block_ids=[], findings=[]))
    with pytest.raises(TrialError, match="coverage"):
        asyncio.run(run_trial(client, [SourceBlock(block_id="p1", text="家に帰った。")]))
    assert not (tmp_path / "result.json").exists()


def test_major_finding_preserves_draft_but_blocks_completion(tmp_path):
    client = FakeClient(tmp_path, Review(checked_block_ids=["p1"], findings=[Finding(
        block_id="p1", severity="major", code="pronoun", source_quote="家に帰った。",
        target_quote="她", explanation="指代待确认")]))
    result = asyncio.run(run_trial(client, [SourceBlock(block_id="p1", text="家に帰った。")]))
    assert result["status"] == "needs_review"
    assert result["draft"]["blocks"][0]["segments"][0]["text"] == "她走回家。"
    assert len(result["repairs"]) == 2


def test_all_five_stages_complete_in_order(tmp_path):
    review = Review(checked_block_ids=["p1"], findings=[])
    client = FakeClient(tmp_path, review)
    result = asyncio.run(run_trial(client, [SourceBlock(block_id="p1", text="家に帰った。")]))
    assert result["status"] == "trial_checks_completed"
    assert [e["stage"] for e in result["events"]] == ["analysis", "draft", "edit", "proofread", "review"]


def test_style_preference_alone_cannot_block_an_entire_book(tmp_path):
    class StyleClient(FakeClient):
        async def call(self, stage, payload, schema):
            if stage == 'draft':
                return Draft(blocks=[block('她说不定会回家。')])
            return await super().call(stage, payload, schema)
    client = StyleClient(tmp_path, Review(checked_block_ids=['p1'], findings=[]))
    result = asyncio.run(run_trial(client, [SourceBlock(block_id='p1', text='家に帰った。')]))
    assert result['status'] == 'trial_checks_completed'
    assert result['deterministic_findings'][0]['severity'] == 'minor'
    assert len(result['repairs']) == 1


@pytest.mark.parametrize('fix_on', [2, 3, None])
def test_style_pass_cannot_exhaust_later_meaning_repairs(tmp_path, fix_on):
    class LateMeaningClient(FakeClient):
        repairs = 0
        async def call(self, stage, payload, schema):
            if stage == 'draft':
                return Draft(blocks=[block('她说不定会散去。')])
            if stage == 'repair':
                self.repairs += 1
                assert payload['read_only_source_context'] == [{'block_id': 'p1', 'text': '家に帰った。'}]
                text = '她回家了。' if self.repairs == fix_on else '她或许会散去。'
                before = payload['blocks'][0]
                return Patches(patches=[Patch(block_id='p1', base_hash=before['base_hash'],
                    replacement_segments=[Segment(text=text, break_after='none')], reason='按原文纠错')])
            if stage == 'review':
                current = payload['candidate']['blocks'][0]['segments'][0]['text']
                findings = [] if self.repairs == 0 or current == '她回家了。' else [Finding(
                    block_id='p1', severity='major', code='misinterpretation', source_quote='家に帰った。',
                    target_quote=current, explanation='原文是回家，译文含义错误。')]
                return Review(checked_block_ids=['p1'], findings=findings)
            return await super().call(stage, payload, schema)
    client = LateMeaningClient(tmp_path, None)
    result = asyncio.run(run_trial(client, [SourceBlock(block_id='p1', text='家に帰った。')]))
    assert result['status'] == ('needs_review' if fix_on is None else 'trial_checks_completed')
    assert client.repairs == (fix_on or 3)
    assert result['repairs'][0]['priority'] == 'advisory'
    assert all(r['priority'] == 'blocking' for r in result['repairs'][1:])


def test_quality_policy_invalidates_only_unfinished_review_and_repair_requests(tmp_path, monkeypatch):
    from app.modules.translation_v2 import pilot
    client = TrialClient('https://example.test/v1', 'key', 'model', tmp_path)
    before = {stage: digest(client.request_body(stage, {}, Draft)) for stage in pilot.PROMPTS}
    body = client.request_body('review', {}, Review)
    assert '不是推荐用词' in body['messages'][0]['content']
    monkeypatch.setattr(pilot, 'QUALITY_POLICY', pilot.QUALITY_POLICY + '\n追加质检澄清')
    after = {stage: digest(client.request_body(stage, {}, Draft)) for stage in pilot.PROMPTS}
    assert {stage for stage in before if before[stage] != after[stage]} == {'review', 'repair'}


def test_known_major_issue_survives_empty_rereview_and_restart_until_block_changes(tmp_path):
    class ForgetfulClient(FakeClient):
        seen = 0
        fix = False
        async def call(self, stage, payload, schema):
            if stage == 'review':
                self.seen += 1
                return self.review if self.seen == 1 else Review(checked_block_ids=['p1'], findings=[])
            if stage == 'repair' and self.fix:
                return Patches(patches=[Patch(block_id='p1', base_hash=payload['blocks'][0]['base_hash'],
                    replacement_segments=[Segment(text='回家了。', break_after='none')], reason='去除无依据的女性指代')])
            return await super().call(stage, payload, schema)
    source = [SourceBlock(block_id='p1', text='家に帰った。')]
    finding = Finding(block_id='p1', severity='major', code='pronoun', source_quote='家に帰った。',
                      target_quote='她', explanation='无依据的女性指代')
    client = ForgetfulClient(tmp_path, Review(checked_block_ids=['p1'], findings=[finding]))
    first = asyncio.run(run_trial(client, source))
    assert first['status'] == 'needs_review' and len(first['repairs']) == 2
    assert (tmp_path / 'blocked-result.json').is_file()
    restarted = ForgetfulClient(tmp_path, Review(checked_block_ids=['p1'], findings=[]))
    second = asyncio.run(run_trial(restarted, source))
    assert second['status'] == 'needs_review' and len(second['repairs']) == 2
    restarted.fix = True
    third = asyncio.run(run_trial(restarted, source))
    assert third['status'] == 'trial_checks_completed'
    assert third['draft']['blocks'][0]['segments'][0]['text'] == '回家了。'


def test_known_issue_receipt_cannot_cross_context_or_accept_corrupt_candidate(tmp_path):
    import json
    client = FakeClient(tmp_path, Review(checked_block_ids=['p1'], findings=[Finding(
        block_id='p1', severity='major', code='pronoun', source_quote='家に帰った。',
        target_quote='她', explanation='指代待确认')]))
    source = [SourceBlock(block_id='p1', text='家に帰った。')]
    asyncio.run(run_trial(client, source, context={'revision': 1}))
    client.review = Review(checked_block_ids=['p1'], findings=[])
    assert asyncio.run(run_trial(client, source, context={'revision': 2}))['status'] == 'trial_checks_completed'
    path = tmp_path / 'blocked-result.json'
    receipt = json.loads(path.read_text(encoding='utf-8'))
    receipt['draft']['blocks'][0]['segments'][0]['text'] = '伪造内容'
    save_json(path, receipt)
    with pytest.raises(TrialError, match='checkpoint_corrupt'):
        asyncio.run(run_trial(client, source, context={'revision': 1}))


@pytest.mark.parametrize('side', ['source', 'target'])
def test_ellipsis_quote_correction_identifies_block_and_requires_verbatim_evidence(side):
    from app.modules.translation_v2.pilot import verified_review
    source = [SourceBlock(block_id='p1', text='最初。中間。最後。')]
    target = Draft(blocks=[block('最初。中间。最后。')])
    calls = []
    class Quotes:
        async def call(self, stage, payload, schema):
            calls.append(payload)
            if len(calls) == 2:
                feedback = payload['validation_feedback']
                assert feedback['invalid_block_id'] == 'p1'
                assert '不能用 … 或 …… 替代省略部分' in feedback['instruction']
            return Review(checked_block_ids=['p1'], findings=[Finding(block_id='p1', severity='minor',
                code='wording', source_quote='最初。……最後。' if side == 'source' and len(calls) == 1 else source[0].text,
                target_quote='最初。……最后。' if side == 'target' and len(calls) == 1 else '最初。中间。最后。',
                explanation='需使用连续引文')])
    review = asyncio.run(verified_review(Quotes(), {'source_blocks': [b.model_dump() for b in source],
        'candidate': target.model_dump()}, source, target))
    assert len(calls) == 2
    check_review(review, source, target)


def test_wire_checkpoint_integrity_and_resume(tmp_path, monkeypatch):
    from app.modules.translation_v2 import pilot
    import httpx
    calls = []
    payload = {"blocks": [{"block_id": "p1", "segments": [{"text": "回家。", "break_after": "none"}]}]}
    response = {"choices": [{"message": {"content": __import__("json").dumps(payload)}, "finish_reason": "stop"}]}
    transport = httpx.MockTransport(lambda request: (calls.append(request), httpx.Response(200, json=response))[1])
    original_client = httpx.AsyncClient
    monkeypatch.setattr(pilot.httpx, "AsyncClient", lambda **kwargs: original_client(transport=transport, **kwargs))
    client = TrialClient("https://example.test/v1", "test-key", "test-model", tmp_path)
    one = asyncio.run(client.call("draft", {"source": "帰る。"}, Draft))
    two = asyncio.run(client.call("draft", {"source": "帰る。"}, Draft))
    assert one == two and len(calls) == 1
    path = next((tmp_path / "checkpoints").glob("*.json"))
    import json
    receipt = json.loads(path.read_text(encoding="utf-8"))
    receipt["output"]["blocks"][0]["segments"][0]["text"] = "被改动"
    save_json(path, receipt)
    with pytest.raises(TrialError, match="checkpoint_corrupt"):
        asyncio.run(client.call("draft", {"source": "帰る。"}, Draft))
    assert len(calls) == 1


def test_complete_receipt_recovers_after_crash_without_another_call(tmp_path, monkeypatch):
    from app.modules.translation_v2 import pilot
    import httpx
    import json
    calls = []
    response = {'choices': [{'message': {'content': json.dumps(Draft(blocks=[block()]).model_dump())}, 'finish_reason': 'stop'}]}
    transport = httpx.MockTransport(lambda request: (calls.append(request), httpx.Response(200, json=response))[1])
    original = httpx.AsyncClient
    monkeypatch.setattr(pilot.httpx, 'AsyncClient', lambda **kwargs: original(transport=transport, **kwargs))
    client = TrialClient('https://example.test/v1', 'test-key', 'model', tmp_path)
    one = asyncio.run(client.call('draft', {}, Draft))
    next((tmp_path / 'checkpoints').glob('*.json')).unlink()
    two = asyncio.run(client.call('draft', {}, Draft))
    assert one == two and len(calls) == 1
    assert client.events[-1]['recovered_receipt'] is True


def test_failed_receipt_does_not_poison_explicit_retry(tmp_path, monkeypatch):
    from app.modules.translation_v2 import pilot
    import httpx
    import json
    responses = iter(['broken', json.dumps(Draft(blocks=[block()]).model_dump())])
    original = httpx.AsyncClient
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={
        'choices': [{'message': {'content': next(responses)}, 'finish_reason': 'stop'}]}))
    monkeypatch.setattr(pilot.httpx, 'AsyncClient', lambda **kwargs: original(transport=transport, **kwargs))
    client = TrialClient('https://example.test/v1', 'test-key', 'model', tmp_path)
    with pytest.raises(TrialError, match='invalid_json'):
        asyncio.run(client.call('draft', {}, Draft))
    assert asyncio.run(client.call('draft', {}, Draft)).blocks == [block()]
    assert len(list((tmp_path / 'receipts').glob('*.json'))) == 2


@pytest.mark.parametrize('status,payload,expected', [
    (401, {'error': {'code': 'invalid_api_key'}}, 'authentication_failed'),
    (429, {'error': {'code': 'rate_limit'}}, 'rate_or_quota_limited'),
    (200, {'choices': [{'message': {'content': ''}, 'finish_reason': 'stop'}]}, 'empty_response'),
    (200, {'choices': [{'message': {'content': '{}'}, 'finish_reason': 'length'}]}, 'truncated_output'),
    (200, {'choices': [{'message': {'content': '{}'}, 'finish_reason': 'stop', 'native_finish_reason': 'SAFETY'}]}, 'provider_rejected'),
    (200, {'choices': [{'message': {'content': 'not json'}, 'finish_reason': 'stop'}]}, 'invalid_json'),
])
def test_wire_failures_never_write_success_or_retry(tmp_path, monkeypatch, status, payload, expected):
    from app.modules.translation_v2 import pilot
    import httpx
    calls = []
    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(lambda request: (calls.append(request), httpx.Response(status, json=payload))[1])
    monkeypatch.setattr(pilot.httpx, 'AsyncClient', lambda **kwargs: original_client(transport=transport, **kwargs))
    client = TrialClient('https://example.test/v1', 'test-key', 'test-model', tmp_path)
    with pytest.raises(TrialError, match=expected):
        asyncio.run(client.call('draft', {'source': '帰る。'}, Draft))
    assert len(calls) == 1
    assert not list((tmp_path / 'checkpoints').glob('*.json'))
    assert client.events[0].get('status') != 'completed'


@pytest.mark.parametrize('streaming', [False, True])
@pytest.mark.parametrize('reason', ['length', 'MAX_TOKENS'])
def test_complete_json_with_truncation_signal_is_not_success(tmp_path, monkeypatch, streaming, reason):
    from app.modules.translation_v2 import pilot
    import httpx
    import json
    content = json.dumps(Draft(blocks=[block()]).model_dump())
    choice = {'native_finish_reason': reason, 'finish_reason': 'stop',
              ('delta' if streaming else 'message'): {'content': content}}
    envelope = {'choices': [choice]}
    response = (httpx.Response(200, text='data: ' + json.dumps(envelope) + '\n\ndata: [DONE]\n\n',
                               headers={'content-type': 'text/event-stream'}) if streaming
                else httpx.Response(200, json=envelope))
    original_client = httpx.AsyncClient
    calls = []
    transport = httpx.MockTransport(lambda request: (calls.append(request), response)[1])
    monkeypatch.setattr(pilot.httpx, 'AsyncClient', lambda **kwargs: original_client(transport=transport, **kwargs))
    client = TrialClient('https://example.test/v1', 'test-key', 'test-model', tmp_path)
    with pytest.raises(TrialError, match='truncated_output'):
        asyncio.run(client.call('draft', {'source': '帰る。'}, Draft))
    assert len(calls) == 1
    assert client.events[0]['status'] == 'failed'
    assert not list((tmp_path / 'checkpoints').glob('*.json'))
