import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from app.core.config import Settings
from app.modules.translations import service
from app.modules.translations.maintenance import translation_is_suspended, require_translation_active
from app.modules.uploads.source_metadata_settings import metadata_translation_settings, MetadataProviderConfigurationError


def suspended(tmp_path):
    marker=tmp_path/'translation-maintenance'/'account-one.json'
    marker.parent.mkdir()
    marker.write_text('{}')
    return Settings(storage_root=str(tmp_path))


def test_hold_is_account_scoped_and_does_not_change_model_settings(tmp_path):
    settings=suspended(tmp_path)
    assert translation_is_suspended(settings,'account-one')
    assert not translation_is_suspended(settings,'account-two')
    with pytest.raises(HTTPException) as error:
        require_translation_active(settings,'account-one')
    assert error.value.status_code==503
    require_translation_active(settings,'account-two')
    with pytest.raises(ValueError):
        translation_is_suspended(settings,'../escape')


def test_suspended_create_never_resolves_channel_or_fetches_source(tmp_path,monkeypatch):
    settings=suspended(tmp_path)
    def unexpected(**kwargs):
        pytest.fail('No provider or source calls while suspended')
    monkeypatch.setattr(service,'resolve_translation_model',unexpected)
    with pytest.raises(HTTPException):
        asyncio.run(service.create_whole_book_translation_job(user_id='account-one',source_url='https://example.invalid',model='keep',channel_id=None,
                    custom_instructions=None,request_concurrency=2,session=None,settings=settings))


def test_suspended_source_update_does_not_queue_and_metadata_does_not_translate(tmp_path):
    settings=suspended(tmp_path)
    assert service.queue_source_update_translation(book=SimpleNamespace(owner_id='account-one'),metadata=None,
                previous_episode_count=1,settings=settings,session=None) is None
    with pytest.raises(MetadataProviderConfigurationError) as error:
        metadata_translation_settings(settings,SimpleNamespace(id='account-one'),None)
    assert error.value.code=='translation_maintenance'


def test_worker_parks_existing_job_without_loading_model(tmp_path,monkeypatch):
    settings=suspended(tmp_path)
    monkeypatch.setattr(service,'_read_job',lambda *args:SimpleNamespace(user_id='account-one',status='queued'))
    updates=[]
    monkeypatch.setattr(service,'_update_job',lambda *args,**kwargs:updates.append(kwargs))
    asyncio.run(service.process_translation_job(job_id='job',settings=settings,session_factory=None))
    assert updates[0]['status']=='paused'
    assert updates[0]['lease_owner'] is None
