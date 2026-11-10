from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.modules.ai_channels.models import AiChannelModelRecord
from app.modules.ai_channels.service import default_translation_model


def create_channel(client, auth_headers, models):
    return client.post('/api/v1/ai-channels', headers=auth_headers, json={
        'name':'Large catalog test','base_url':'https://example.com/v1','api_key':'test-key','models':models})


@pytest.mark.parametrize('value', ['', None, 0, 499, 20001, 500.5, 'Infinity'])
def test_invalid_character_limit_does_not_partially_update_channel(client, auth_headers, value):
    channel = create_channel(client, auth_headers, [{'model': 'original'}]).json()
    response = client.patch('/api/v1/ai-channels/' + channel['id'], headers=auth_headers,
        json={'name': 'Must not persist', 'models': [{'model': 'original', 'chunk_characters': value}]})
    assert response.status_code == 422
    assert client.get('/api/v1/ai-channels/' + channel['id'], headers=auth_headers).json() == channel


@pytest.mark.parametrize('characters,concurrency', [(500, 5), (20000, 7), (4500, 16)])
def test_character_boundaries_and_all_concurrency_values_are_preserved(client, auth_headers, characters, concurrency):
    response = create_channel(client, auth_headers, [{'model': 'configured', 'chunk_characters': characters, 'max_concurrency': concurrency}])
    assert response.status_code == 201
    model = response.json()['models'][0]
    assert model['chunk_characters'] == characters and model['max_concurrency'] == concurrency


@pytest.mark.parametrize('selected', [0, 3, 60])
def test_catalog_size_does_not_count_toward_enabled_limit(client, auth_headers, selected):
    models = [{'model':f'model-{i}','enabled':i<selected} for i in range(300)]
    response = create_channel(client, auth_headers, models)
    assert response.status_code == 201, response.text
    assert len(response.json()['models']) == selected


def test_more_than_60_enabled_is_rejected_without_partial_update(client, auth_headers):
    channel = create_channel(client, auth_headers, [{'model':'original'}]).json()
    response = client.patch('/api/v1/ai-channels/'+channel['id'], headers=auth_headers,
        json={'name':'Should not persist','models':[{'model':f'model-{i}'} for i in range(61)]})
    assert response.status_code == 409
    saved = client.get('/api/v1/ai-channels/'+channel['id'], headers=auth_headers).json()
    assert saved['name'] == channel['name']
    assert [m['model'] for m in saved['models']] == ['original']


def test_disabled_saved_model_keeps_id_and_tuning_and_can_be_reenabled(client, auth_headers):
    channel = create_channel(client, auth_headers, [{'model':'saved','max_concurrency':8}]).json()
    url = '/api/v1/ai-channels/'+channel['id']
    models = [{'model':'saved','enabled':False,'max_concurrency':8}]+[
        {'model':f'model-{i}','enabled':i<3} for i in range(300)]
    result = client.patch(url, headers=auth_headers, json={'models':models})
    assert result.status_code == 200, result.text
    saved = next(m for m in result.json()['models'] if m['model']=='saved')
    assert saved['id'] == channel['models'][0]['id']
    assert saved['max_concurrency'] == 8 and saved['enabled'] is False
    models[0]['enabled'] = True
    assert client.patch(url,headers=auth_headers,json={'models':models}).json()['models'][0]['enabled'] is True


def test_duplicate_model_names_count_once(client, auth_headers):
    result = create_channel(client, auth_headers, [{'model':' same '},{'model':'same'}]*40)
    assert result.status_code == 201, result.text
    assert len(result.json()['models']) == 1


def test_rejected_creation_does_not_leave_empty_channel(client, auth_headers):
    before = client.get('/api/v1/ai-channels',headers=auth_headers).json()
    result = create_channel(client,auth_headers,[{'model':f'model-{i}'} for i in range(61)])
    assert result.status_code == 409
    assert client.get('/api/v1/ai-channels',headers=auth_headers).json() == before


def test_channel_update_rejects_stale_updated_at(client, auth_headers):
    channel = create_channel(client, auth_headers, [{'model': 'original'}]).json()
    url = '/api/v1/ai-channels/' + channel['id']
    first = client.patch(url, headers=auth_headers, json={
        'expected_updated_at': channel['updated_at'], 'name': 'first update',
    })
    assert first.status_code == 200, first.text
    stale = client.patch(url, headers=auth_headers, json={
        'expected_updated_at': channel['updated_at'], 'name': 'stale update',
    })
    assert stale.status_code == 409
    assert client.get(url, headers=auth_headers).json()['name'] == 'first update'


def test_default_translation_model_skips_unavailable_lanes(client, auth_headers):
    channel = create_channel(client, auth_headers, [{'model': 'gemini-ready'}]).json()
    user_id = client.app.state.settings.default_user_id
    with client.app.state.db_session_factory() as session:
        model = session.scalar(select(AiChannelModelRecord).where(AiChannelModelRecord.channel_id == channel['id']))
        assert model is not None
        model.unavailable_until = datetime.now(timezone.utc) + timedelta(hours=1)
        session.commit()
        assert default_translation_model(user_id=user_id, preferred_model=None, session=session) is None


def test_default_translation_model_can_exclude_a_rejected_lane(client, auth_headers):
    channel = create_channel(client, auth_headers, [
        {'model': 'gemini-rejected'},
        {'model': 'gemini-fallback'},
    ]).json()
    user_id = client.app.state.settings.default_user_id
    with client.app.state.db_session_factory() as session:
        lane = default_translation_model(
            user_id=user_id,
            preferred_model=None,
            excluded_models={'gemini-rejected'},
            session=session,
        )
        assert lane is not None
        assert lane[0].id == channel['id']
        assert lane[1].model == 'gemini-fallback'


def test_default_translation_model_can_limit_fallback_family(client, auth_headers):
    channel = create_channel(client, auth_headers, [
        {'model': 'other-provider-model'},
        {'model': 'gemini-fallback'},
    ]).json()
    user_id = client.app.state.settings.default_user_id
    with client.app.state.db_session_factory() as session:
        lane = default_translation_model(
            user_id=user_id,
            preferred_model=None,
            model_filter=lambda model: 'gemini' in model,
            session=session,
        )
        assert lane is not None
        assert lane[0].id == channel['id']
        assert lane[1].model == 'gemini-fallback'


def test_default_translation_model_can_keep_policy_retry_on_original_channel(client, auth_headers):
    first = create_channel(client, auth_headers, [{'model': 'gemini-rejected'}, {'model': 'gemini-fallback'}]).json()
    second = create_channel(client, auth_headers, [{'model': 'gemini-other-channel'}]).json()
    user_id = client.app.state.settings.default_user_id
    with client.app.state.db_session_factory() as session:
        lane = default_translation_model(
            user_id=user_id,
            preferred_model=None,
            excluded_models={'gemini-rejected'},
            model_filter=lambda model: 'gemini' in model,
            channel_id=first['id'],
            session=session,
        )
        assert lane is not None
        assert lane[0].id == first['id']
        assert lane[1].model == 'gemini-fallback'
        assert second['id'] != lane[0].id
