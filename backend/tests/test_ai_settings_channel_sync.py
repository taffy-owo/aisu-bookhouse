import pytest


def save_provider(client, headers, **changes):
    return client.put('/api/v1/auth/me/ai-settings', headers=headers, json={
        'provider_base_url': 'https://inline.example.com/v1',
        'api_key': 'inline-test-key', 'translation_model': 'inline-model', **changes,
    })


def test_provider_save_does_not_repoint_an_independently_created_channel(client, auth_headers):
    independent = client.post('/api/v1/ai-channels', headers=auth_headers, json={
        'name': 'Independent channel', 'base_url': 'https://independent.example.com/v1',
        'api_key': 'independent-test-key', 'models': [{'model': 'independent-model'}],
    }).json()
    assert save_provider(client, auth_headers).status_code == 200
    actual = client.get('/api/v1/ai-channels/' + independent['id'], headers=auth_headers).json()
    assert actual == independent
    channels = client.get('/api/v1/ai-channels', headers=auth_headers).json()
    assert len(channels) == 2


def test_prompt_only_save_does_not_restore_old_channel_credentials(client, auth_headers):
    assert save_provider(client, auth_headers).status_code == 200
    channel = client.get('/api/v1/ai-channels', headers=auth_headers).json()[0]
    changed = client.patch('/api/v1/ai-channels/' + channel['id'], headers=auth_headers,
        json={'base_url': 'https://changed.example.com/v1', 'api_key': 'changed-test-key'}).json()
    response = client.put('/api/v1/auth/me/ai-settings', headers=auth_headers, json={'translation_prompt': 'Keep names consistent.'})
    assert response.status_code == 200
    actual = client.get('/api/v1/ai-channels/' + channel['id'], headers=auth_headers).json()
    assert actual == changed


def test_default_channel_keeps_identity_custom_name_disabled_state_and_model_tuning(client, auth_headers):
    assert save_provider(client, auth_headers).status_code == 200
    channel = client.get('/api/v1/ai-channels', headers=auth_headers).json()[0]
    assert channel['is_provider_default'] is True
    changed = client.patch('/api/v1/ai-channels/' + channel['id'], headers=auth_headers, json={
        'name': 'Renamed default', 'enabled': False,
        'models': [{'model': 'inline-model', 'max_concurrency': 8, 'chunk_characters': 6000}],
    }).json()
    assert save_provider(client, auth_headers, provider_base_url='https://new.example.com/v1', translation_model='new-model').status_code == 200
    channels = client.get('/api/v1/ai-channels', headers=auth_headers).json()
    assert len(channels) == 1
    result = channels[0]
    assert result['id'] == channel['id'] and result['name'] == 'Renamed default' and result['enabled'] is False
    assert result['base_url'] == 'https://new.example.com/v1'
    assert result['models'][0] == changed['models'][0]
    assert [model['model'] for model in result['models']] == ['inline-model', 'new-model']
    assert 'api_key' not in result


def test_editing_linked_channel_credentials_updates_inline_provider_only(client, auth_headers):
    assert save_provider(client, auth_headers, translation_prompt='Preset', audiobook_provider_base_url='https://speech.example.com/v1',
        audiobook_api_key='speech-key', audiobook_tts_model='speech-model').status_code == 200
    channel = client.get('/api/v1/ai-channels', headers=auth_headers).json()[0]
    response = client.patch('/api/v1/ai-channels/' + channel['id'], headers=auth_headers,
        json={'base_url': 'https://changed.example.com/v1', 'api_key': 'changed-key'})
    assert response.status_code == 200
    saved = client.get('/api/v1/auth/me/ai-settings', headers=auth_headers).json()
    assert saved['provider_base_url'] == 'https://changed.example.com/v1'
    assert saved['api_key_configured'] is True
    assert saved['translation_prompt'] == 'Preset'
    assert saved['audiobook_api_key_configured'] is True and saved['audiobook_provider_base_url'] == 'https://speech.example.com/v1'


@pytest.mark.parametrize('operation', ['channel', 'settings'])
def test_remove_clears_the_linked_credentials_without_touching_independent_channels(client, auth_headers, operation):
    independent = client.post('/api/v1/ai-channels', headers=auth_headers, json={
        'name': 'Keep this channel', 'base_url': 'https://independent.example.com/v1', 'api_key': 'independent-key',
        'models': [{'model': 'independent-model'}],
    }).json()
    assert save_provider(client, auth_headers, audiobook_provider_base_url='https://speech.example.com/v1',
        audiobook_api_key='speech-key', audiobook_tts_model='speech-model').status_code == 200
    linked = next(channel for channel in client.get('/api/v1/ai-channels', headers=auth_headers).json() if channel['is_provider_default'])
    url = '/api/v1/ai-channels/' + linked['id'] if operation == 'channel' else '/api/v1/auth/me/ai-settings'
    assert client.delete(url, headers=auth_headers).status_code == 200
    saved = client.get('/api/v1/auth/me/ai-settings', headers=auth_headers).json()
    assert saved['provider_base_url'] == '' and saved['api_key_configured'] is False and saved['translation_model'] == ''
    assert saved['audiobook_api_key_configured'] is (operation == 'channel')
    assert client.get('/api/v1/ai-channels', headers=auth_headers).json() == [independent]


@pytest.mark.parametrize('operation', ['channel', 'settings'])
def test_active_job_blocks_removal_without_partial_configuration_changes(client, auth_headers, monkeypatch, operation):
    assert save_provider(client, auth_headers).status_code == 200
    settings = client.get('/api/v1/auth/me/ai-settings', headers=auth_headers).json()
    channel = client.get('/api/v1/ai-channels', headers=auth_headers).json()[0]
    monkeypatch.setattr('app.modules.ai_channels.service._active_job_counts', lambda *_: {(channel['id'], 'inline-model'): 1})
    url = '/api/v1/ai-channels/' + channel['id'] if operation == 'channel' else '/api/v1/auth/me/ai-settings'
    assert client.delete(url, headers=auth_headers).status_code == 409
    assert client.get('/api/v1/auth/me/ai-settings', headers=auth_headers).json() == settings
    assert client.get('/api/v1/ai-channels', headers=auth_headers).json() == [channel]


def test_model_limit_rolls_back_provider_and_channel_changes_together(client, auth_headers):
    assert save_provider(client, auth_headers).status_code == 200
    channel = client.get('/api/v1/ai-channels', headers=auth_headers).json()[0]
    assert client.patch('/api/v1/ai-channels/' + channel['id'], headers=auth_headers,
        json={'models': [{'model': f'configured-{index}'} for index in range(60)]}).status_code == 200
    settings = client.get('/api/v1/auth/me/ai-settings', headers=auth_headers).json()
    channel = client.get('/api/v1/ai-channels', headers=auth_headers).json()[0]
    result = save_provider(client, auth_headers, provider_base_url='https://not-saved.example.com/v1', translation_model='new-over-limit-model')
    assert result.status_code == 409
    assert client.get('/api/v1/auth/me/ai-settings', headers=auth_headers).json() == settings
    assert client.get('/api/v1/ai-channels', headers=auth_headers).json() == [channel]


def test_channel_limit_does_not_partially_save_provider_credentials(client, auth_headers, monkeypatch):
    monkeypatch.setattr('app.modules.ai_channels.service.MAX_CHANNELS_PER_USER', 1)
    independent = client.post('/api/v1/ai-channels', headers=auth_headers, json={
        'name': 'Existing', 'base_url': 'https://independent.example.com/v1', 'api_key': 'independent-key', 'models': [],
    }).json()
    settings = client.get('/api/v1/auth/me/ai-settings', headers=auth_headers).json()
    assert save_provider(client, auth_headers).status_code == 409
    assert client.get('/api/v1/auth/me/ai-settings', headers=auth_headers).json() == settings
    assert client.get('/api/v1/ai-channels', headers=auth_headers).json() == [independent]


def test_partial_provider_clear_returns_the_actual_cleared_configuration(client, auth_headers):
    assert save_provider(client, auth_headers).status_code == 200
    response = client.put('/api/v1/auth/me/ai-settings', headers=auth_headers, json={'provider_base_url': ''})
    assert response.status_code == 200
    assert response.json() == client.get('/api/v1/auth/me/ai-settings', headers=auth_headers).json()
    assert response.json()['api_key_configured'] is False
    assert response.json()['translation_model'] == ''
    assert client.get('/api/v1/ai-channels', headers=auth_headers).json() == []


def test_audiobook_only_save_does_not_change_linked_channel_version(client, auth_headers):
    assert save_provider(client, auth_headers).status_code == 200
    channel = client.get('/api/v1/ai-channels', headers=auth_headers).json()[0]
    result = client.put('/api/v1/auth/me/ai-settings', headers=auth_headers, json={
        'audiobook_provider_base_url': 'https://speech.example.com/v1', 'audiobook_api_key': 'speech-key', 'audiobook_tts_model': 'speech-model',
    })
    assert result.status_code == 200
    assert client.get('/api/v1/ai-channels', headers=auth_headers).json() == [channel]


@pytest.mark.parametrize('clear', ['audiobook', 'translation'])
def test_clearing_one_provider_keeps_the_other_provider_and_preset(client, auth_headers, clear):
    assert save_provider(client, auth_headers, translation_prompt='Preserved preset',
        audiobook_provider_base_url='https://voice.example.com/v1', audiobook_api_key='voice-key',
        audiobook_tts_model='voice-model', audiobook_tts_voice='alloy').status_code == 200
    previous = client.get('/api/v1/auth/me/ai-settings', headers=auth_headers).json()
    channels = client.get('/api/v1/ai-channels', headers=auth_headers).json()
    payload = ({'audiobook_provider_base_url': None, 'audiobook_tts_model': None, 'audiobook_tts_voice': None, 'clear_audiobook_api_key': True}
        if clear == 'audiobook' else {'provider_base_url': None, 'translation_model': None, 'clear_api_key': True})
    result = client.put('/api/v1/auth/me/ai-settings', headers=auth_headers, json=payload)
    assert result.status_code == 200
    saved = result.json()
    assert saved == client.get('/api/v1/auth/me/ai-settings', headers=auth_headers).json()
    assert saved['translation_prompt'] == 'Preserved preset'
    assert saved['api_key_configured'] is (clear != 'translation')
    assert saved['audiobook_api_key_configured'] is (clear != 'audiobook')
    if clear == 'audiobook':
        assert saved['provider_base_url'] == previous['provider_base_url']
        assert client.get('/api/v1/ai-channels', headers=auth_headers).json() == channels
    else:
        assert saved['audiobook_provider_base_url'] == previous['audiobook_provider_base_url']
        assert client.get('/api/v1/ai-channels', headers=auth_headers).json() == []


def test_clearing_both_providers_during_an_active_job_keeps_all_credentials(client, auth_headers, monkeypatch):
    assert save_provider(client, auth_headers, audiobook_provider_base_url='https://voice.example.com/v1',
        audiobook_api_key='voice-key', audiobook_tts_model='voice-model').status_code == 200
    previous = client.get('/api/v1/auth/me/ai-settings', headers=auth_headers).json()
    channels = client.get('/api/v1/ai-channels', headers=auth_headers).json()
    monkeypatch.setattr('app.modules.ai_channels.service._active_job_counts', lambda *_: {(channels[0]['id'], 'inline-model'): 1})
    result = client.put('/api/v1/auth/me/ai-settings', headers=auth_headers, json={
        'provider_base_url': None, 'translation_model': None, 'clear_api_key': True,
        'audiobook_provider_base_url': None, 'audiobook_tts_model': None, 'audiobook_tts_voice': None, 'clear_audiobook_api_key': True,
    })
    assert result.status_code == 409
    assert client.get('/api/v1/auth/me/ai-settings', headers=auth_headers).json() == previous
    assert client.get('/api/v1/ai-channels', headers=auth_headers).json() == channels
