import asyncio
import json

import httpx
import pytest

from app.core.config import Settings
from app.modules.translations import ai


@pytest.mark.parametrize('reason', list(ai.FILTER_REASONS))
@pytest.mark.parametrize('streaming', [True, False])
def test_original_filter_reason_survives_compatibility_stop(reason, streaming):
    body = {'choices': [{'finish_reason': 'stop', 'native_finish_reason': reason.upper(),
                         'delta' if streaming else 'message': {'content': 'partial'}}]}
    response = httpx.Response(200, text='data: '+json.dumps(body)+'\n\n' if streaming else json.dumps(body),
                              headers={'x-request-id': 'request-123'})
    with pytest.raises(ai.ContentFilteredError) as failure:
        ai.parse_structured_http_response(response, streaming=streaming)
    diagnostic = failure.value.diagnostics
    assert diagnostic['native_finish_reason'] == reason.upper()
    assert diagnostic['finish_reason'] == 'stop'
    assert diagnostic['reason'] == reason
    assert diagnostic['request_id'] == 'request-123'
    assert diagnostic['http_status'] == 200
    assert 'partial' not in str(failure.value)


@pytest.mark.parametrize('block', [None, '', 0, 'BLOCK_REASON_UNSPECIFIED', 'UNSPECIFIED'])
def test_default_feedback_does_not_reject_success(block):
    payload = {'promptFeedback': {'blockReason': block},
               'choices': [{'message': {'content': '{"translations":["测试"]}'}}]}
    assert ai.parse_structured_response(payload) == {'translations': ['测试']}


def test_actual_feedback_still_blocks_and_does_not_record_prose():
    with pytest.raises(ai.ContentFilteredError) as failure:
        ai.parse_structured_response({'promptFeedback': {'blockReason': 'SAFETY', 'blockReasonMessage': 'private prompt'}})
    assert failure.value.diagnostics['reason'] == 'SAFETY'
    assert 'private' not in str(failure.value)


def test_numeric_http_code_does_not_hide_specific_error_type():
    with pytest.raises(ai.ContentFilteredError) as failure:
        ai.parse_structured_response({'error': {'code':403, 'type':'SAFETY'}})
    assert failure.value.diagnostics['provider_error_code'] == '403'
    assert failure.value.diagnostics['provider_error_type'] == 'SAFETY'


def test_multiline_sse_bom_comments_and_keepalive():
    body = '\ufeff: heartbeat\n\ndata: \n\nevent: message\ndata: {"choices": [\ndata: {"delta":{"content":"{\\"translations\\":[\\"测试\\"]}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n'
    response = httpx.Response(200, text=body, headers={'content-type':'text/event-stream'})
    assert ai.parse_structured_http_response(response, streaming=True) == {'translations':['测试']}


def test_broken_sse_is_not_silently_accepted():
    response = httpx.Response(200, text='data: {broken\n\ndata: [DONE]\n')
    with pytest.raises(json.JSONDecodeError):
        ai.parse_structured_http_response(response, streaming=True)


def test_http_policy_error_is_not_retried_as_format_failure(tmp_path):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(400, json={'error': {'code': 'content_policy_violation', 'message':'private'}},
                              headers={'x-request-id':'sk-private-secret'})
    async def run():
        settings = Settings(storage_root=str(tmp_path), ai_translation_base_url='https://example.invalid/v1', ai_translation_api_key='private')
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            async with ai.translation_diagnostics_scope(chapter=2, chunk=3):
                ai.set_translation_diagnostic_phase('译文校对')
                with pytest.raises(ai.ContentFilteredError) as failure:
                    await ai._post_with_retries(client, settings, {'model':'test', 'response_format':{'type':'json_object'}})
                assert failure.value.diagnostics['phase'] == '译文校对'
                assert failure.value.diagnostics['chapter'] == 2
                assert failure.value.diagnostics['http_status'] == 400
                assert 'private' not in str(failure.value)
            assert not ai.translation_diagnostic_context.get()
    asyncio.run(run())
    assert len(calls) == 1


def test_concurrent_phases_do_not_bleed_between_chapters():
    async def call(chapter):
        async with ai.translation_diagnostics_scope(chapter=chapter, chunk=1):
            ai.set_translation_diagnostic_phase(str(chapter))
            await asyncio.sleep(0)
            error = ai.ContentFilteredError('test')
            assert error.diagnostics == {'chapter':chapter, 'chunk':1, 'phase':str(chapter)}
    async def run():
        await asyncio.gather(call(1), call(2))
    asyncio.run(run())
