import asyncio
import json

import pytest

from app.modules.translation_v2.pilot import (
    Draft, SourceBlock, TrialError, run_trial, digest,
)
from app.modules.translation_v2.whole_chapter import WholeChapterClient


SOURCE = [SourceBlock(block_id='p1', text='彼女はまだ帰っていない。'),
          SourceBlock(block_id='p2', text='私は待った。')]


def block(id, text):
    return {'block_id': id, 'segments': [{'text': text, 'break_after': 'none'}]}


class DirectClient:
    whole_chapter = direct_translation = True

    def __init__(self, root, *, problem=False, no_op=False, advisory=False, still_bad=False):
        self.root, self.events, self.payloads = root, [], []
        self.problem, self.no_op, self.advisory, self.still_bad = problem, no_op, advisory, still_bad
        self.repairs = 0

    async def call(self, stage, payload, schema):
        self.events.append({'stage': stage})
        self.payloads.append((stage, payload))
        if stage == 'draft':
            assert 'analysis' not in payload
            data = {'blocks': [block('p1', '她已经回来了。' if self.problem else '她还没回来。'),
                               block('p2', '我等着。')]}
        elif stage == 'review':
            findings = []
            for b in payload['candidate']['blocks']:
                if b['block_id'] == 'p1' and b['segments'][0]['text'] != '她还没回来。':
                    findings.append({'block_id': 'p1', 'severity': 'major', 'code': 'negation',
                        'source_quote': SOURCE[0].text, 'target_quote': b['segments'][0]['text'],
                        'explanation': '尚未回来被误译为已经回来。'})
                if b['block_id'] == 'p2' and self.advisory:
                    findings.append({'block_id': 'p2', 'severity': 'minor', 'code': 'wording',
                        'source_quote': SOURCE[1].text, 'target_quote': '我等着。',
                        'explanation': '也可写成我在等。'})
            data = {'checked_block_ids': [b['block_id'] for b in payload['source_blocks']], 'findings': findings}
        elif stage == 'repair':
            self.repairs += 1
            assert payload['affected_block_ids'] == ['p1']
            assert all(f['block_id'] == 'p1' for f in payload['issues'])
            data = {'patches': [] if self.no_op else [{'block_id': 'p1',
                'base_hash': payload['blocks'][0]['base_hash'],
                'replacement_segments': block('p1', ('她早就回来了。' if self.repairs == 1 else '她回来了。')
                    if self.still_bad else '她还没回来。')['segments'], 'reason': '恢复否定'}]}
        else:
            raise AssertionError(f'Unnecessary stage: {stage}')
        return schema.model_validate(data)


def test_good_draft_needs_only_one_independent_review(tmp_path):
    client = DirectClient(tmp_path)
    result = asyncio.run(run_trial(client, SOURCE))
    assert result['status'] == 'trial_checks_completed'
    assert [e['stage'] for e in client.events] == ['draft', 'review']
    assert result['patch_counts'] == {} and result['repairs'] == []


def test_advisory_does_not_cause_rewrite(tmp_path):
    client = DirectClient(tmp_path, advisory=True)
    result = asyncio.run(run_trial(client, SOURCE))
    assert result['status'] == 'trial_checks_completed' and not result['repairs']
    assert result['review']['findings'][0]['severity'] == 'minor'


def test_only_real_error_repaired_and_changed_block_rechecked(tmp_path):
    client = DirectClient(tmp_path, problem=True, advisory=True)
    result = asyncio.run(run_trial(client, SOURCE))
    assert result['status'] == 'trial_checks_completed'
    assert [e['stage'] for e in client.events] == ['draft', 'review', 'repair', 'review']
    last = client.payloads[-1][1]
    assert [b['block_id'] for b in last['source_blocks']] == ['p1']
    assert len(last['read_only_source_context']) == len(last['read_only_candidate_context']['blocks']) == 2
    assert result['review']['checked_block_ids'] == ['p1', 'p2']
    assert result['review']['findings'][0]['block_id'] == 'p2'
    assert result['draft']['blocks'][1] == block('p2', '我等着。')


def test_no_op_repair_cannot_erase_major_or_trigger_repeated_review(tmp_path):
    client = DirectClient(tmp_path, problem=True, no_op=True)
    result = asyncio.run(run_trial(client, SOURCE))
    assert result['status'] == 'needs_review'
    assert [e['stage'] for e in client.events] == ['draft', 'review', 'repair', 'repair']
    assert client.repairs == 2  # A no-op gets one focused correction, without another review.
    assert result['review']['findings'][0]['severity'] == 'major'


def test_two_unsuccessful_repairs_stop_without_publishing(tmp_path):
    client = DirectClient(tmp_path, problem=True, still_bad=True)
    result = asyncio.run(run_trial(client, SOURCE))
    assert result['status'] == 'needs_review' and client.repairs == 2
    assert len(client.events) == 6


def test_missing_paragraph_still_blocks_direct_workflow(tmp_path):
    class Missing(DirectClient):
        async def call(self, stage, payload, schema):
            result = await super().call(stage, payload, schema)
            return result.model_copy(update={'blocks': result.blocks[:1]}) if stage == 'draft' else result
    with pytest.raises(TrialError, match='block_coverage_mismatch'):
        asyncio.run(run_trial(Missing(tmp_path), SOURCE))


def test_actual_wire_prompt_contains_fidelity_and_no_legacy_conflict(tmp_path):
    client = WholeChapterClient('https://example.test/v1', 'fake-key', 'model', tmp_path,
        guard=lambda: None, report=lambda *a: None, lane_root=tmp_path)
    body = client.request_body('draft', {'source_blocks': [b.model_dump() for b in SOURCE]}, Draft)
    prompt = body['messages'][0]['content']
    for rule in ('原作者怎么描述', '不擅自淡化', '不添加情色细节', '彼女先判定',
                 '内心保留矛盾与锋芒', '不得跨 block', '仅输出', '一次请求'):
        assert rule in prompt
    assert '逐块初译' not in prompt
    assert '风格改写目标：' not in prompt
    assert json.loads(body['messages'][1]['content'])['source_blocks'][0]['text'] == SOURCE[0].text


def test_name_annotation_is_allowed_once_only_at_verified_first_position():
    from app.modules.translation_v2.runner import first_name_annotation_positions
    from app.modules.translations.source_text import SourceChapter
    from app.modules.translation_v2.pilot import check_text
    glossary = [{'source': 'アリス', 'target': '爱丽丝'}, {'source': '真奈', 'target': '真奈'}]
    chapters = [SourceChapter(index=i, title='第一話', paragraphs=['アリスは笑った。'], url=f'https://example.test/{i}')
                for i in (1, 2)]
    positions = first_name_annotation_positions(glossary, chapters)
    assert positions == [{'source': 'アリス', 'target': '爱丽丝', 'block_id': 'c1:p1'}]
    assert first_name_annotation_positions(glossary, chapters, {'アリス'}) == []
    for blocks, codes in [([block('c1:p1', '爱丽丝（アリス）笑了。')], []),
                          ([block('c1:p1', '爱丽丝（アリス）与爱丽丝（アリス）。')], ['unexpected_kana']),
                          ([block('c2:p1', '爱丽丝（アリス）笑了。')], ['unexpected_kana']),
                          ([block('c1:p1', 'こんにちは。')], ['unexpected_kana'])]:
        assert [f['code'] for f in check_text(Draft.model_validate({'blocks': blocks}), name_annotations=positions)] == codes


@pytest.mark.parametrize('legacy', [False, True])
def test_previously_completed_chapter_survives_prompt_upgrade(client, auth_headers, monkeypatch, legacy):
    from test_translation_v2_production import prepare, FakeStageClient
    from app.modules.translation_v2 import runner
    from app.modules.translations import service
    from app.modules.translations.models import WholeBookTranslationJobRecord as Job
    from pathlib import Path
    job_id, sessions, settings = prepare(client, auth_headers, monkeypatch)
    asyncio.run(service.process_translation_job(job_id=job_id, settings=settings,
        session_factory=sessions, lease_owner='v2-test-lease'))
    with sessions() as session:
        job = session.get(Job, job_id)
        root = Path(settings.storage_root) / 'translation-v2' / job.user_id / job.id
        chapter = runner.read_snapshot(root / 'source' / '00001.json')
        planning_path = next((root / 'planning').glob('*.json'))
        glossary = runner.read_snapshot(planning_path)['glossary']
        completed_input = {'planning': planning_path.stem, 'glossary': glossary, 'source': chapter,
            'prior_summary': '', 'prior_tail': [],
            'prompts': runner.COMMON + json.dumps(runner.PROMPTS, ensure_ascii=False, sort_keys=True)}
        key = digest(completed_input if legacy else {**completed_input, 'generation_mode': 'whole-chapter-v1',
            'stage_prompts': runner.WHOLE_CHAPTER_PROMPTS})
        checkpoint = next((root / 'completed').glob('*.json'))
        preserved = checkpoint.read_bytes()
        old_path = root / 'completed' / (key + '.json')
        checkpoint.rename(old_path)
        job.status, job.lease_owner = 'processing', 'resume-lease'
        session.commit()
    FakeStageClient.calls = []
    asyncio.run(service.process_translation_job(job_id=job_id, settings=settings,
        session_factory=sessions, lease_owner='resume-lease'))
    assert FakeStageClient.calls == ['metadata']
    assert old_path.read_bytes() == preserved
    with sessions() as session:
        assert session.get(Job, job_id).status == 'ready'
