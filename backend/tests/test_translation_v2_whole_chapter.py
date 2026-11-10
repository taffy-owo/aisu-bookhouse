import asyncio
import json
from contextlib import asynccontextmanager
import httpx
import pytest

from app.modules.translation_v2 import runtime
from app.modules.translation_v2.whole_chapter import WholeChapterClient
from app.modules.translation_v2.context import verified_context_plan, group_blocks, merge_terms
from app.modules.translation_v2.pilot import SourceBlock, Draft, TrialClient, TrialError, run_trial


def sources(n=147):
    return [SourceBlock(block_id=f'c2:p{i+1}', text='彼女は笑った。') for i in range(n)]


def client(path):
    return WholeChapterClient('https://example.test/v1','fake-key','gemini-3-flash-preview', path,
        guard=lambda:None, report=lambda *a:None, lane_root=path.parent, capacity=4)


def test_regular_chapter_is_not_split_by_characters_or_paragraph_count():
    blocks = [SourceBlock(block_id=f'p{i}',text='原文'*100) for i in range(147)]
    assert group_blocks(blocks) == [blocks]


def test_entire_chapter_each_stage_no_patch_protocol_and_two_books_can_overlap(tmp_path, monkeypatch):
    @asynccontextmanager
    async def unlocked(*a, **kw): yield
    monkeypatch.setattr(runtime,'lane_lock',unlocked)
    active=peak=0
    calls=[]
    async def send(self,body,event,stage):
        nonlocal active,peak
        payload=json.loads(body['messages'][1]['content'])
        blocks=payload['source_blocks']
        assert len(blocks)==147 and 'parallel_scope' not in payload
        calls.append(stage)
        active+=1; peak=max(peak,active)
        await asyncio.sleep(.005)
        active-=1
        if stage=='analysis':
            out={'blocks':[{'block_id':b['block_id'],'speaker':None,'implied_subject':None,'facts':[],'uncertainties':[]} for b in blocks]}
        elif stage in ('draft','edit','proofread'):
            assert set(payload['output_schema']['properties'])=={'blocks'}
            if stage!='draft':
                assert len(payload['candidate']['blocks'])==147
                assert '完整' in body['messages'][0]['content']
            out={'blocks':[{'block_id':b['block_id'],'segments':[{'text':'她笑了。','break_after':'none'}]} for b in blocks]}
        else:
            out={'checked_block_ids':[b['block_id'] for b in blocks],'findings':[]}
        return httpx.Response(200,json={'choices':[{'message':{'content':json.dumps(out)},'finish_reason':'stop'}]})
    monkeypatch.setattr(TrialClient,'send',send)
    async def run():
        return await asyncio.gather(*(run_trial(client(tmp_path/str(i)),sources()) for i in range(2)))
    results=asyncio.run(run())
    assert all(r['status']=='trial_checks_completed' and r['target_block_count']==147 for r in results)
    assert len(calls)==4 and peak==2
    assert set(calls) == {'draft', 'review'}
    asyncio.run(run())
    assert len(calls)==4


def test_missing_edit_paragraph_reasks_entire_chapter_not_only_missing(tmp_path,monkeypatch):
    from app.modules.translation_v2.pilot import verified_block_output
    payloads=[]
    class Fake:
        whole_chapter=True
        async def call(self,stage,payload,schema):
            payloads.append(payload)
            assert len(payload['source_blocks'])==147
            n=6 if len(payloads)==1 else 147
            return Draft.model_validate({'blocks':[{'block_id':b.block_id,'segments':[{'text':'她笑了。','break_after':'none'}]} for b in sources()[:n]]})
    result=asyncio.run(verified_block_output(Fake(),'edit',{'source_blocks':[b.model_dump() for b in sources()]},Draft,sources()))
    assert len(result.blocks)==147 and len(payloads)==2
    assert payloads[1]['whole_chapter_correction']['attempt']==1
    assert payloads[1]['whole_chapter_correction']['missing_ids'][0] == 'c2:p7'
    assert payloads[1]['whole_chapter_correction']['expected_count'] == 147
    assert payloads[1]['whole_chapter_correction']['received_count'] == 6


def test_one_missing_analysis_block_gets_specific_feedback_without_splitting_chapter():
    from app.modules.translation_v2.pilot import Analysis, AnalysisBlock, verified_block_output
    blocks = sources(141)
    seen = []
    class Fake:
        whole_chapter = True
        async def call(self, stage, payload, schema):
            seen.append(payload)
            selected = blocks if len(seen) > 1 else [b for b in blocks if b.block_id != 'c2:p72']
            if len(seen) > 1:
                assert payload['whole_chapter_correction']['missing_ids'] == ['c2:p72']
                assert len(payload['source_blocks']) == 141
            return Analysis(blocks=[AnalysisBlock(block_id=b.block_id, speaker=None,
                implied_subject=None, facts=['她笑了'], uncertainties=[]) for b in selected])
    result = asyncio.run(verified_block_output(Fake(), 'analysis', {'source_blocks':[b.model_dump() for b in blocks]}, Analysis, blocks))
    assert len(result.blocks) == 141 and len(seen) == 2


@pytest.mark.parametrize('recover',[True,False])
def test_invalid_pronoun_evidence_does_not_pollute_glossary_or_kill_book(recover):
    blocks=[SourceBlock(block_id='c2:p7',text='探している“大切な子”？')]
    calls=[]
    class Fake:
        async def call(self,stage,payload,schema):
            calls.append(payload)
            terms=[] if recover and len(calls)>1 else [{'source':'あの子','target':'那个孩子','evidence_block_id':'c2:p7',
                'evidence_quote':'探している“大切な子”？','note':''}]
            return schema.model_validate({'checked_block_ids':['c2:p7'],'terms':terms,'summary':'寻找重要的人。','voice_notes':[],'uncertainties':[]})
    diagnostics=[]
    plan=asyncio.run(verified_context_plan(Fake(),{'source_blocks':[b.model_dump() for b in blocks]},blocks,diagnostics=diagnostics))
    assert plan.terms==[] and merge_terms([],plan,blocks)==[]
    assert len(calls)==(2 if recover else 3)
    if not recover:
        assert diagnostics[0]['code']=='unsupported_term_not_adopted'


def test_missing_context_coverage_is_not_invented():
    class Fake:
        async def call(self,stage,payload,schema):
            return schema.model_validate({'checked_block_ids':[],'terms':[],'summary':'','voice_notes':[],'uncertainties':[]})
    with pytest.raises(TrialError,match='context_coverage_mismatch'):
        asyncio.run(verified_context_plan(Fake(),{},sources(1),diagnostics=[]))
