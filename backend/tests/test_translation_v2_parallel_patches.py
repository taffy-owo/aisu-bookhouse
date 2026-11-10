import asyncio
from contextlib import asynccontextmanager
import json
import os

import httpx
import pytest

from app.modules.translation_v2.pilot import (
    Draft, Patches, Review, Analysis, TrialClient, TrialError, digest, verified_patches, run_trial, SourceBlock,
)
from app.modules.translation_v2.parallel import ParallelStageClient
from app.modules.translation_v2 import runtime


def candidate():
    return Draft.model_validate({'blocks': [{'block_id': 'p1', 'segments': [{'text': '她点头。', 'break_after': 'none'}]}]})


@pytest.mark.parametrize('stage', ['edit', 'proofread', 'repair'])
def test_wrong_hash_gets_new_bound_token_request_without_overwrite(stage):
    draft = candidate()
    before = draft.model_dump()
    payloads = []
    class Fake:
        async def call(self, name, payload, schema):
            payloads.append(payload)
            assert draft.model_dump() == before
            token = 'invented' if len(payloads) == 1 else payload['blocks'][0]['base_hash']
            return Patches.model_validate({'patches': [{'block_id': 'p1', 'base_hash': token,
                'replacement_segments': [{'text': '她点了点头。', 'break_after': 'none'}], 'reason': '语法'}]})
    changes, repaired = asyncio.run(verified_patches(Fake(), stage, {'blocks': [
        {**draft.blocks[0].model_dump(), 'base_hash': digest(before['blocks'][0])}]}, draft))
    assert draft.model_dump() == before and len(payloads) == 2
    assert payloads[1]['blocks'][0]['base_hash'].startswith('v:')
    assert changes.patches[0].base_hash == digest(before['blocks'][0])
    assert repaired.blocks[0].segments[0].text == '她点了点头。'


@pytest.mark.parametrize('mode', ['wrong_hash', 'duplicate', 'outside'])
def test_bad_patch_is_bounded_and_never_applied(mode):
    calls = []
    draft = candidate()
    before = draft.model_dump()
    class Fake:
        async def call(self, stage, payload, schema):
            calls.append(payload)
            patch = {'block_id': 'other' if mode == 'outside' else 'p1',
                'base_hash': 'wrong' if mode == 'wrong_hash' else payload['blocks'][0]['base_hash'],
                'replacement_segments': [{'text': '替换', 'break_after': 'none'}], 'reason': '测试'}
            return Patches.model_validate({'patches': [patch] * (2 if mode == 'duplicate' else 1)})
    with pytest.raises(TrialError) as failure:
        asyncio.run(verified_patches(Fake(), 'repair', {'blocks': [
            {**draft.blocks[0].model_dump(), 'base_hash': digest(before['blocks'][0])}]}, draft, allowed_ids={'p1'}))
    assert len(calls) == 3 and draft.model_dump() == before
    assert failure.value.details['corrective_attempts'] == 2


def source(n=32):
    return [{'block_id': f'p{i}', 'text': '彼女は笑った。'} for i in range(n)]


def client(tmp_path, capacity=4):
    return ParallelStageClient('https://example.test/v1', 'fake-key', 'gemini-3-flash-preview', tmp_path / 'unit',
        guard=lambda: None, report=lambda *a: None, lane_root=tmp_path, capacity=capacity)


def test_all_stages_actually_parallel_keep_context_order_and_resume(tmp_path, monkeypatch):
    @asynccontextmanager
    async def unlocked(*args, **kwargs):
        yield
    monkeypatch.setattr(runtime, 'lane_lock', unlocked)
    active = 0
    peak = 0
    sent = []
    async def send(self, body, event, stage):
        nonlocal active, peak
        payload = json.loads(body['messages'][1]['content'])
        assert len(payload['read_only_source_context']) == 32
        assert payload['context']['glossary'] == {'fields': ['source', 'target'], 'rows': [['彼女', '她']]}
        blocks = payload['source_blocks']
        assert [b['block_id'] for b in blocks] == payload['parallel_scope']['required_ids']
        active += 1
        peak = max(peak, active)
        sent.append(stage)
        await asyncio.sleep(.025 if blocks[0]['block_id'] == 'p0' else .005)
        active -= 1
        if stage == 'analysis':
            data = {'blocks': [{**{'block_id': b['block_id']}, 'speaker': None, 'implied_subject': None,
                'facts': [], 'uncertainties': []} for b in blocks]}
        elif stage == 'draft':
            assert len(payload['read_only_analysis_context']['blocks']) == 32
            data = {'blocks': [{'block_id': b['block_id'], 'segments': [{'text': '她笑了。', 'break_after': 'none'}]} for b in blocks]}
        elif stage in ('edit', 'proofread'):
            assert len(payload['read_only_candidate_context']['blocks']) == 32
            data = {'patches': []}
        else:
            assert len(payload['read_only_candidate_context']['blocks']) == 32
            data = {'checked_block_ids': [b['block_id'] for b in blocks], 'findings': []}
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(data)}, 'finish_reason': 'stop'}]})
    monkeypatch.setattr(TrialClient, 'send', send)
    async def run():
        return await run_trial(client(tmp_path), [SourceBlock(**b) for b in source()],
            context={'glossary': [{'source': '彼女', 'target': '她'}]})
    result = asyncio.run(run())
    assert peak == 4 and active == 0 and len(sent) == 20
    assert result['status'] == 'trial_checks_completed'
    assert [b['block_id'] for b in result['draft']['blocks']] == [b['block_id'] for b in source()]
    assert asyncio.run(run())['target_hash'] == result['target_hash']
    assert len(sent) == 20  # All real shard checkpoints restored, no extra calls.


def test_failed_shard_waits_for_siblings_and_reuses_completed_results(tmp_path, monkeypatch):
    @asynccontextmanager
    async def unlocked(*args, **kwargs):
        yield
    monkeypatch.setattr(runtime, 'lane_lock', unlocked)
    completed = []
    async def send(self, body, event, stage):
        payload = json.loads(body['messages'][1]['content'])
        blocks = payload['source_blocks']
        if blocks[0]['block_id'] == 'p0':
            raise TrialError('transport_outcome_unknown', fingerprint='failed-shard')
        await asyncio.sleep(.02)
        completed.append(blocks[0]['block_id'])
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps({'blocks': [
            {'block_id': b['block_id'], 'segments': [{'text': '她笑了。', 'break_after': 'none'}]} for b in blocks]})}}]})
    monkeypatch.setattr(TrialClient, 'send', send)
    for _ in range(2):
        with pytest.raises(TrialError, match='transport_outcome_unknown'):
            asyncio.run(client(tmp_path).call('draft', {'source_blocks': source()}, Draft))
        assert len(completed) == 3
    assert len(list((tmp_path / 'unit/parallel/draft').rglob('checkpoints/*.json'))) == 3


@pytest.mark.skipif(os.name != 'posix', reason='Production POSIX flock')
def test_real_lane_slots_limit_concurrent_requests_and_release_after_error(tmp_path):
    active = peak = 0
    async def work(i):
        nonlocal active, peak
        async with runtime.lane_lock(tmp_path, 'shared-model', lambda: None, capacity=4):
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(.025)
            active -= 1
    async def run():
        await asyncio.gather(*(work(i) for i in range(9)))
    asyncio.run(run())
    assert peak == 4 and active == 0


@pytest.mark.skipif(os.name != 'posix', reason='Production cross-process POSIX flock')
def test_four_slots_are_shared_between_worker_processes(tmp_path):
    import subprocess
    import sys
    code = """
import asyncio,json,sys,time
from pathlib import Path
from app.modules.translation_v2.runtime import lane_lock
async def one():
    async with lane_lock(Path(sys.argv[1]), 'model', lambda: None, capacity=4):
        start=time.monotonic()
        await asyncio.sleep(.12)
        print(json.dumps([start,time.monotonic()]),flush=True)
async def main():
    await asyncio.gather(*(one() for _ in range(4)))
asyncio.run(main())
"""
    workers = [subprocess.Popen([sys.executable, '-c', code, str(tmp_path)], stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True) for _ in range(2)]
    points = []
    for worker in workers:
        out, error = worker.communicate(timeout=30)
        assert worker.returncode == 0, error
        for line in out.splitlines():
            start,end = json.loads(line)
            points.extend([(start,1),(end,-1)])
    active = peak = 0
    for _,change in sorted(points):
        active += change
        peak = max(peak,active)
    assert len(points) == 16 and peak == 4 and active == 0
