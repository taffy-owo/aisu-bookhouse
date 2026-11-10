from dataclasses import replace
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app.modules.ai_channels.models import AiChannelModelRecord, AiChannelRecord
from app.modules.japanese.schemas import JapaneseAiTranslationResponse
from app.modules.translations.ai import ContentFilteredError, RateLimitedError, CallBudgetExhaustedError, ProviderUnavailableError
from app.modules.uploads.schemas import WorkSourceMetadata
from app.modules.uploads.source_metadata_translation import metadata_translation_error
from app.modules.uploads.source_metadata_translation import translate_source_metadata
from app.core.config import Settings


URL = 'https://kakuyomu.jp/works/16800000000000000000'


def configure(client, auth_headers, monkeypatch):
    client.app.state.settings = replace(client.app.state.settings,
        ai_translation_base_url='https://old.example.com/v1',ai_translation_api_key='legacy-test-key',
        ai_translation_model='old-model')
    async def lookup(url):
        return WorkSourceMetadata(author='作者',character_count=10,episode_count=1,
            publication_status='completed',source='kakuyomu',source_url=URL,tags=[],title='図書館')
    monkeypatch.setattr('app.modules.uploads.api.fetch_work_source_metadata',lookup)
    response = client.post('/api/v1/ai-channels',headers=auth_headers,json={
        'name':'GG test','base_url':'https://gg.example.com/v1','api_key':'new-test-key',
        'models':[{'model':'agy-gemini-test','max_concurrency':2}]})
    assert response.status_code == 201
    return response.json()


def test_metadata_uses_saved_channel_not_legacy_config(client,auth_headers,monkeypatch):
    configure(client,auth_headers,monkeypatch)
    captured = []
    async def translate(items, settings, **kwargs):
        captured.append(settings)
        return JapaneseAiTranslationResponse(model=settings.ai_translation_model, translations=['图书馆'])
    monkeypatch.setattr('app.modules.uploads.source_metadata_translation.translate_japanese_metadata',translate)
    response = client.post('/api/v1/uploads/source-metadata',headers=auth_headers,json={'url':URL})
    assert response.status_code == 200
    result = response.json()
    assert result['translation_status'] == 'translated'
    assert result['translation_channel'] == 'GG test'
    assert result['translation_model'] == 'agy-gemini-test'
    assert len(captured) == 1
    assert captured[0].ai_translation_base_url == 'https://gg.example.com/v1'
    assert captured[0].ai_translation_api_key == 'new-test-key'
    assert captured[0].ai_translation_secondary_model == ''
    assert captured[0].ai_translation_daily_call_budget == 0
    assert captured[0].ai_translation_max_concurrency == 2
    assert 'new-test-key' not in response.text


def test_metadata_exposes_same_channel_gemini_fallback_lanes(client,auth_headers,monkeypatch):
    channel = configure(client,auth_headers,monkeypatch)
    client.patch('/api/v1/ai-channels/'+channel['id'],headers=auth_headers,json={
        'models': [
            {'model':'gemini-primary','sort_order':0,'max_concurrency':6},
            {'model':'gemini-secondary','sort_order':1,'max_concurrency':4},
            {'model':'gemini-rescue','sort_order':2,'max_concurrency':3},
        ]})
    captured = []
    async def translate(items, settings, **kwargs):
        captured.append(settings)
        return JapaneseAiTranslationResponse(model=settings.ai_translation_model, translations=['图书馆'])
    monkeypatch.setattr('app.modules.uploads.source_metadata_translation.translate_japanese_metadata',translate)
    response = client.post('/api/v1/uploads/source-metadata',headers=auth_headers,json={'url':URL})
    assert response.status_code == 200
    assert captured[0].ai_translation_model == 'gemini-primary'
    assert captured[0].ai_translation_secondary_model == 'gemini-secondary'
    assert captured[0].ai_translation_rescue_model == 'gemini-rescue'


def test_metadata_preview_uses_current_preset_and_does_not_reuse_previous_translation(client,auth_headers,monkeypatch):
    configure(client,auth_headers,monkeypatch)

    async def lookup(url):
        return WorkSourceMetadata(author='作者',character_count=10,episode_count=1,
            publication_status='completed',source='kakuyomu',source_url=URL,tags=[],title='雪乃と雨の日の図書室')

    monkeypatch.setattr('app.modules.uploads.api.fetch_work_source_metadata',lookup)
    calls = []
    titles = {'雪乃固定译为雪乃。':'雪乃与雨天图书室', '雪乃固定译为小雪。':'小雪与雨天图书室', '':'默认译名与雨天图书室'}

    async def translate(items,settings,*,translation_preferences):
        calls.append(translation_preferences)
        return [titles[translation_preferences]]

    monkeypatch.setattr('app.modules.japanese.service._request_ai_metadata_translations',translate)
    for preset,title in titles.items():
        updated = client.put('/api/v1/auth/me/ai-settings',headers=auth_headers,json={'translation_prompt':preset})
        assert updated.status_code == 200
        for _ in range(2):
            response = client.post('/api/v1/uploads/source-metadata',headers=auth_headers,json={'url':URL})
            assert response.status_code == 200
            assert response.json()['title'] == title
    assert calls == list(titles)


def test_metadata_ignores_non_gemini_models_when_building_fallback_lanes(client,auth_headers,monkeypatch):
    channel = configure(client,auth_headers,monkeypatch)
    client.patch('/api/v1/ai-channels/'+channel['id'],headers=auth_headers,json={
        'models': [
            {'model':'other-provider-primary','sort_order':0},
            {'model':'gemini-primary','sort_order':1},
            {'model':'gemini-rescue','sort_order':2},
        ]})
    captured = []
    async def translate(items, settings, **kwargs):
        captured.append(settings)
        return JapaneseAiTranslationResponse(model=settings.ai_translation_model, translations=['图书馆'])
    monkeypatch.setattr('app.modules.uploads.source_metadata_translation.translate_japanese_metadata',translate)
    response = client.post('/api/v1/uploads/source-metadata',headers=auth_headers,json={'url':URL})
    assert response.status_code == 200
    assert captured[0].ai_translation_model == 'gemini-primary'
    assert captured[0].ai_translation_secondary_model == 'gemini-rescue'
    assert captured[0].ai_translation_rescue_model == ''


@pytest.mark.parametrize('unavailable', ['disabled_channel','disabled_model','quota'])
def test_saved_but_unavailable_channel_does_not_resurrect_legacy(client,auth_headers,monkeypatch,unavailable):
    channel = configure(client,auth_headers,monkeypatch)
    if unavailable == 'disabled_channel':
        client.patch('/api/v1/ai-channels/'+channel['id'],headers=auth_headers,json={'enabled':False})
    elif unavailable == 'disabled_model':
        client.patch('/api/v1/ai-channels/'+channel['id'],headers=auth_headers,
            json={'models':[{'model':'agy-gemini-test','enabled':False}]})
    else:
        with client.app.state.db_session_factory() as session:
            model = session.get(AiChannelModelRecord,channel['models'][0]['id'])
            model.unavailable_until = datetime.now(timezone.utc)+timedelta(hours=1)
            session.commit()
    async def forbidden(*args,**kwargs):
        pytest.fail('Unavailable saved channel must not use legacy provider')
    monkeypatch.setattr('app.modules.uploads.source_metadata_translation.translate_japanese_metadata',forbidden)
    result = client.post('/api/v1/uploads/source-metadata',headers=auth_headers,json={'url':URL}).json()
    assert result['title'] == '図書館'
    assert result['translation_status'] == 'unavailable'
    assert result['translation_error_code'] == 'no_available_model'


def test_refusal_is_reported_and_not_retried_on_other_channel(client,auth_headers,monkeypatch):
    configure(client,auth_headers,monkeypatch)
    client.post('/api/v1/ai-channels',headers=auth_headers,json={'name':'Other',
        'base_url':'https://other.example.com/v1','api_key':'other-test-key','models':[{'model':'other'}]})
    calls = []
    async def translate(items,settings,**kwargs):
        calls.append(settings.ai_translation_model)
        raise ContentFilteredError('synthetic refusal')
    monkeypatch.setattr('app.modules.uploads.source_metadata_translation.translate_japanese_metadata',translate)
    result = client.post('/api/v1/uploads/source-metadata',headers=auth_headers,json={'url':URL}).json()
    assert result['translation_error_code'] == 'refused'
    assert '其他 Gemini 模型' in result['translation_error_message']
    assert '正忙' not in result['translation_error_message']
    assert result['translation_channel'] == 'GG test'
    assert calls == ['agy-gemini-test']


@pytest.mark.parametrize('error,code', [
    (ContentFilteredError('secret'), 'refused'),
    (RateLimitedError('secret'), 'rate_limited'),
    (RateLimitedError('secret',quota_exhausted=True), 'quota_exhausted'),
    (CallBudgetExhaustedError('secret'), 'quota_exhausted'),
    (httpx.ReadTimeout('secret'), 'timeout'),
    (httpx.ConnectError('secret'), 'connection'),
    (ValueError('secret'), 'invalid_response'),
    (RuntimeError('secret'), 'translation_failed'),
])
def test_safe_metadata_failure_reason(error,code):
    actual,message = metadata_translation_error(error)
    assert actual == code
    assert 'secret' not in message


@pytest.mark.parametrize('status,code',[(401,'authentication'),(403,'authentication'),(429,'rate_limited'),(503,'provider_error')])
def test_http_failure_reason(status,code):
    request = httpx.Request('POST','https://example.com')
    error = httpx.HTTPStatusError('secret',request=request,response=httpx.Response(status,request=request))
    actual,message = metadata_translation_error(error)
    assert actual == code and 'secret' not in message


def test_wrapped_connection_error_is_not_called_busy():
    error = ProviderUnavailableError('secret')
    error.__cause__ = httpx.ConnectError('secret')
    assert metadata_translation_error(error)[0] == 'connection'


def test_corrupt_saved_key_reports_configuration_problem(client,auth_headers,monkeypatch):
    channel = configure(client,auth_headers,monkeypatch)
    with client.app.state.db_session_factory() as session:
        session.get(AiChannelRecord,channel['id']).api_key_encrypted = 'invalid-test-ciphertext'
        session.commit()
    response = client.post('/api/v1/uploads/source-metadata',headers=auth_headers,json={'url':URL})
    assert response.status_code == 200
    assert response.json()['translation_error_code'] == 'invalid_credentials'
    assert 'invalid-test-ciphertext' not in response.text


@pytest.mark.asyncio
async def test_missing_model_is_configuration_error_not_provider_busy():
    metadata = WorkSourceMetadata(author='作者',character_count=10,episode_count=1,
        publication_status='completed',source='kakuyomu',source_url=URL,tags=[],title='図書館')
    result = await translate_source_metadata(metadata, Settings(ai_translation_base_url='https://example.com/v1',
        ai_translation_api_key='test-key',ai_translation_model=''))
    assert result.translation_error_code == 'not_configured'
