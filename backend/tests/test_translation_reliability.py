import asyncio
from dataclasses import replace
import json
from concurrent.futures import ThreadPoolExecutor
import threading
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from app.core.config import Settings
from app.modules.translations import ai, service
from app.modules.translations.models import WholeBookTranslationJobRecord
from app.modules.translations.source_text import SourceChapter


@pytest.mark.parametrize('content', [None, ''])
def test_nonstream_empty_length_is_not_retried_as_bad_json(content):
    with pytest.raises(ai.ResponseTruncatedError):
        ai.parse_structured_response({'choices':[{'finish_reason':'length','message':{'content':content}}]})


@pytest.mark.parametrize('message,reason', [({'content':None},'content_filter'), ({'content':None,'refusal':'refused'},'stop'), ({'content':'partial'},'content_filter')])
def test_explicit_refusal_is_terminal(message, reason):
    with pytest.raises(ai.ContentFilteredError) as failure:
        ai.parse_structured_response({'choices':[{'finish_reason':reason,'message':message}]})
    assert not service._is_transient_translation_error(failure.value)


def test_sse_response_detected_even_if_requested_as_json():
    event = {'choices':[{'delta':{'content':'{"translations":["你好"]}'},'finish_reason':'stop'}]}
    response = httpx.Response(200, text='data: '+json.dumps(event)+'\n\ndata: [DONE]\n')
    assert ai.parse_structured_http_response(response, streaming=False) == {'translations':['你好']}


CPA_TEXT_REFUSAL = (
    "The prompt could not be submitted. The prompt contains sensitive words "
    "that violate Google's [Generative AI Prohibited Use policy]"
    "(https://policies.google.com/terms/generative-ai/use-policy)."
)


@pytest.mark.parametrize('streaming', [False, True])
def test_cpa_plain_text_refusal_with_null_reasons_is_terminal(streaming):
    parts = [CPA_TEXT_REFUSAL[:63], CPA_TEXT_REFUSAL[63:]]
    if streaming:
        body = ''.join('data: '+json.dumps({'choices':[{'delta':{'content':part},
            'finish_reason':None,'native_finish_reason':None}]})+'\n\n' for part in parts)
        response = httpx.Response(200, text=body+'data: [DONE]\n\n', headers={'content-type':'text/event-stream'})
    else:
        response = httpx.Response(200, json={'choices':[{'message':{'content':CPA_TEXT_REFUSAL},
            'finish_reason':None,'native_finish_reason':None}]})
    with pytest.raises(ai.ContentFilteredError) as failure:
        ai.parse_structured_http_response(response, streaming=streaming)
    assert not service._is_transient_translation_error(failure.value)


def test_policy_words_inside_valid_translation_are_not_a_refusal():
    value = {'translations':[CPA_TEXT_REFUSAL]}
    assert ai.parse_structured_response({'choices':[{'message':{'content':json.dumps(value)}}]}) == value


def test_unrecognized_plain_text_remains_a_json_error():
    with pytest.raises(json.JSONDecodeError):
        ai.parse_structured_response({'choices':[{'message':{'content':'temporarily unavailable'}}]})


def test_text_policy_refusal_does_not_spend_retry_calls(tmp_path):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={'choices':[{'message':{'content':CPA_TEXT_REFUSAL}}]})
    async def run():
        settings = Settings(storage_root=str(tmp_path), ai_translation_base_url='https://example.com/v1', ai_translation_api_key='test')
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(ai.ContentFilteredError):
                await ai._post_with_retries(client, settings, {'model':'test'})
    asyncio.run(run())
    assert len(calls) == 1


@pytest.mark.parametrize('streaming',[False,True])
@pytest.mark.parametrize('native,expected',[('prohibited_content',ai.ContentFilteredError),('SAFETY',ai.ContentFilteredError),('max_tokens',ai.ResponseTruncatedError)])
def test_cpa_native_reason_overrides_misleading_stop(streaming,native,expected):
    first={'finish_reason':'stop','native_finish_reason':native,
           'delta' if streaming else 'message':{'content':'{"translations":["unfinished'}}
    payload={'choices':[first]}
    response=httpx.Response(200,text='data: '+json.dumps(payload)+'\n\ndata: [DONE]\n') if streaming else httpx.Response(200,json=payload)
    with pytest.raises(expected):
        ai.parse_structured_http_response(response,streaming=streaming)


def test_cpa_refusal_is_never_retried_or_sent_to_fallback(monkeypatch, tmp_path):
    calls=[]
    async def post(client,settings,payload,**kwargs):
        calls.append(payload['model'])
        return ai.parse_structured_response({'choices':[{'finish_reason':'stop','native_finish_reason':'prohibited_content','message':{'content':'partial'}}]})
    monkeypatch.setattr(ai,'_post_with_retries',post)
    settings=Settings(storage_root=str(tmp_path), ai_translation_base_url='https://example.com/v1',ai_translation_api_key='test',ai_translation_model='gemini-3.8-flash-high',ai_translation_secondary_model='another-model')
    with pytest.raises(ai.ContentFilteredError):
        asyncio.run(ai.request_structured_ai(settings,system_prompt='synthetic',user_payload={}))
    assert calls==['gemini-3.8-flash-high']


@pytest.mark.parametrize('model',['gemini-3.8-flash-high','agy-gemini-3.8-flash-high','cpa/gemini-3.8-flash-high'])
def test_gemini_new_aliases_use_streaming(model):
    assert ai.uses_streaming(model)


def test_legacy_ambiguous_lock_is_advisory_but_real_names_remain_locked():
    memory = service._coerce_memory({'glossary':[
        {'source':'ひな','target':'日南 / 小日南','locked':True},
        {'source':'シルヴィア','target':'西尔维娅','locked':True},
    ]})
    assert not service._deterministic_quality_issues(['ひなは笑った。'],['日南笑了。'],memory)
    assert service._deterministic_quality_issues(['シルヴィアは笑った。'],['西尔维亚笑了。'],memory)[0].severity == 'hard'
    unresolved = next(item for item in memory['glossary'] if item['source']=='ひな')
    assert unresolved['locked'] is False and unresolved['needs_resolution'] is True
    repaired = service._coerce_memory({'glossary':[{'source':'ひな','target':'日南','locked':True}]},fallback=memory)
    assert next(item for item in repaired['glossary'] if item['source']=='ひな')['target'] == '日南'


@pytest.mark.parametrize('message',['第 1 话质检不通过','第 1 话全书译名一致性检查不通过','历史一致性修复失败'])
def test_quality_failure_does_not_retry_as_transport_error(message):
    assert not service._is_transient_translation_error(ValueError(message))


def test_draft_checkpoint_is_validated_and_not_in_published_chapter_directory(tmp_path):
    settings=Settings(storage_root=str(tmp_path))
    chapter=SourceChapter(index=1,title='测试',url='https://example.com/1',paragraphs=['こんにちは。'])
    result=(['你好。'],{'chunks':[]})
    service._save_translation_draft(settings,'user','job',chapter,result)
    assert service._load_translation_draft(settings,'user','job',chapter) == result
    assert not service._translated_chapter_path(settings,'user','job',1).exists()
    assert service._load_translation_draft(settings,'user','job',replace(chapter,paragraphs=['変更。'])) is None
    assert service._load_translation_draft(replace(settings,ai_translation_model='changed'),'user','job',chapter) is None
    assert service._load_translation_draft(settings,'user','job',chapter,'new preferences') is None


@pytest.mark.parametrize('payload',[{'index':1,'paragraphs':[]},{'index':2,'paragraphs':['你好']},{'index':1,'paragraphs':[None]}, {'index':1,'paragraphs':['你好'],'source_hash':'different'},None])
def test_corrupt_completed_checkpoint_is_preserved_but_never_published(tmp_path,payload):
    chapter=SourceChapter(index=1,title='测试',url='https://example.com/1',paragraphs=['こんにちは。'])
    path=tmp_path/'translated'/'00001.json'
    path.parent.mkdir()
    raw=json.dumps(payload).encode() if payload is not None else b'{unfinished'
    path.write_bytes(raw)
    assert service._load_completed_translation_checkpoint(path,chapter) is None
    assert not path.exists()
    preserved=list((tmp_path/'invalid-checkpoints').glob('*.json'))
    assert len(preserved)==1 and preserved[0].read_bytes()==raw


def test_original_epub_survives_a_failed_staging_write(tmp_path,monkeypatch):
    settings=Settings(storage_root=str(tmp_path))
    relative=Path('originals/test/original.epub')
    original=tmp_path/relative
    original.parent.mkdir(parents=True)
    original.write_bytes(b'existing-complete-epub')
    def fail_write(*,relative_path,**kwargs):
        (tmp_path/relative_path).write_bytes(b'partial')
        raise OSError('simulated disk failure')
    monkeypatch.setattr(service,'write_bytes_file',fail_write)
    with pytest.raises(OSError):
        service._store_translation_epub_atomic(b'new-epub',relative,settings)
    assert original.read_bytes()==b'existing-complete-epub'
    assert list(original.parent.iterdir())==[original]


def test_repeated_source_dialogue_is_not_deduplicated():
    from app.modules.translations.source_text import SourceBodyHTMLParser
    parser=SourceBodyHTMLParser('kakuyomu')
    parser.feed('<div class="widget-episodeBody"><p>「待って！」</p><p>「待って！」</p></div>')
    assert parser.paragraphs==['「待って！」','「待って！」']


def test_publication_requires_every_chapter_file(tmp_path):
    settings=Settings(storage_root=str(tmp_path))
    assets=[SimpleNamespace(index=1,path='chapter1.txt')]
    with pytest.raises(ValueError,match='目录'):
        service._validate_published_translation_assets(assets,2,settings)
    with pytest.raises(ValueError,match='文件不可用'):
        service._validate_published_translation_assets(assets,1,settings)
    (tmp_path/'chapter1.txt').write_text('完整章节',encoding='utf-8')
    service._validate_published_translation_assets(assets,1,settings)


@pytest.mark.parametrize('report',[
    {'history:1':{'remaining':['历史待修'], 'deferred_editorial_repair':True}},
    {'1':{'chunks':[], 'post_window_consistency':{'remaining':['译名待修']}}},
    {'1':{'chunks':[{'stitch':{'remaining':[], 'degraded':['审校未完成']}}]}},
])
def test_quality_badge_accounts_for_all_barriers(report):
    record=WholeBookTranslationJobRecord(completed_chapters=1,quality_report_json=report,memory_json={})
    assert service._translation_quality_summary(record) == ('warning',1)


def test_http_gate_shared_by_windows_but_isolates_credentials():
    async def run():
        settings=Settings(ai_translation_api_key='test-key', ai_translation_base_url='https://example.com/v1',ai_translation_max_concurrency=2)
        active=peak=0
        async def handler(request):
            nonlocal active, peak
            active+=1
            peak=max(active,peak)
            await asyncio.sleep(.01)
            active-=1
            return httpx.Response(200,json={'choices':[{'message':{'content':'{}'}}]})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await asyncio.gather(*(ai._post_with_retries(client,settings,{'model':'test'}) for _ in range(8)))
        assert peak==2
        assert ai._request_limiter(settings) is not ai._request_limiter(replace(settings,ai_translation_api_key='different'))
    asyncio.run(run())


def test_shape_recovery_keeps_interpretation_aligned(monkeypatch):
    calls=[]
    async def request(_settings, *, user_payload, **kwargs):
        calls.append(user_payload)
        size=len(user_payload['source'])
        return {'translations':['译文']*(size if size<4 else size-1)}
    monkeypatch.setattr(service,'request_structured_ai',request)
    payload={'source':['一','二','三','四'], 'interpretation':{'interpretations':[{'paragraph':i,'speaker':str(i)} for i in range(1,5)]}}
    asyncio.run(service._request_translation_list(settings=Settings(),system_prompt='test',user_payload=payload,expected_count=4,temperature=.1))
    assert [entry['speaker'] for entry in calls[1]['interpretation']['interpretations']] == ['1','2']
    assert calls[2]['interpretation']['interpretations'] == [{'paragraph':1,'speaker':'3'}, {'paragraph':2,'speaker':'4'}]


def test_request_gate_also_limits_separate_worker_event_loops():
    settings=Settings(ai_translation_api_key='cross-thread-only',ai_translation_base_url='https://example.com/v1',ai_translation_max_concurrency=1)
    lock=threading.Lock()
    active=peak=0
    async def work():
        nonlocal active,peak
        async with ai._request_limiter(settings):
            with lock:
                active+=1
                peak=max(peak,active)
            await asyncio.sleep(.03)
            with lock:
                active-=1
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures=[executor.submit(asyncio.run,work()) for _ in range(2)]
        for future in futures:
            future.result()
    assert peak==1
