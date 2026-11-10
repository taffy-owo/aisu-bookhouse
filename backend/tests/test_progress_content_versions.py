from datetime import datetime, timedelta, timezone

import pytest

from app.core.config import Settings
from app.modules.reading_progress.repository import SqlAlchemyReadingProgressRepository
from test_chapter_mutation_receipts import make_book


def current(client, headers, bid):
    return client.get(f'/api/v1/books/{bid}/reader', headers=headers).json()


def raw(client, bid):
    with client.app.state.db_session_factory() as session:
        return SqlAlchemyReadingProgressRepository(session).get(Settings.default_user_id, bid)


@pytest.mark.parametrize('ext', ['txt', 'epub'])
@pytest.mark.parametrize('keyed', [True, False])
def test_delayed_old_revision_cannot_overwrite_progress_after_a_body_edit(client, auth_headers, ext, keyed):
    bid = make_book(client, auth_headers, ext)
    resource = current(client, auth_headers, bid)
    chapter = resource['toc'][1]
    old_time = datetime.now(timezone.utc) - timedelta(minutes=1)
    payload = {'reader_type': resource['reader_type'], 'chapter_index': 2, 'epub_cfi': 'aisu-scroll:0.4',
               'progress_percent': 50, 'content_version': chapter['content_version'], 'updated_at': old_time.isoformat()}
    if keyed:
        payload['position_key'] = chapter['position_key']
    assert client.put(f'/api/v1/books/{bid}/progress', headers=auth_headers, json=payload).status_code == 200
    assert client.put(f'/api/v1/books/{bid}/chapters/2', headers=auth_headers, json={'content': '补充了新的前文。\n\n正文修订后，原来的偏移不能直接照搬。'}).status_code == 200
    before = raw(client, bid)
    stale = {**payload, 'epub_cfi': 'aisu-scroll:0.95', 'updated_at': datetime.now(timezone.utc).isoformat()}
    response = client.put(f'/api/v1/books/{bid}/progress', headers=auth_headers, json=stale)
    assert response.status_code == 409, response.text
    assert raw(client, bid) == before
    assert before.updated_at == old_time
    revised = current(client, auth_headers, bid)['toc'][1]
    assert revised['position_key'] == chapter['position_key'] and revised['content_version'] != chapter['content_version']
    response = client.put(f'/api/v1/books/{bid}/progress', headers=auth_headers, json={**stale, 'content_version': revised['content_version']})
    assert response.status_code == 200, response.text
    assert raw(client, bid).epub_cfi == 'aisu-scroll:0.95'


@pytest.mark.parametrize('ext', ['txt', 'epub'])
def test_append_preserves_a_loaded_chapters_version_and_recalculates_current_weights(client, auth_headers, ext):
    bid = make_book(client, auth_headers, ext)
    resource = current(client, auth_headers, bid)
    chapter = resource['toc'][2]
    assert client.post(f'/api/v1/books/{bid}/chapters', headers=auth_headers, json={'title': '新追加的一话', 'content': '还没有读到的新正文。' * 100}).status_code == 200
    assert current(client, auth_headers, bid)['toc'][2]['content_version'] == chapter['content_version']
    response = client.put(f'/api/v1/books/{bid}/progress', headers=auth_headers, json={
        'reader_type': resource['reader_type'], 'chapter_index': 3, 'position_key': chapter['position_key'],
        'content_version': chapter['content_version'], 'epub_cfi': 'aisu-scroll:1', 'progress_percent': 100})
    assert response.status_code == 200, response.text
    assert 0 < response.json()['progress_percent'] < 100


def test_optional_revision_keeps_legacy_api_clients_and_manual_progress_compatible(client, auth_headers):
    bid = make_book(client, auth_headers)
    assert client.put(f'/api/v1/books/{bid}/chapters/2', headers=auth_headers, json={'content': '修订后的正文。'}).status_code == 200
    response = client.put(f'/api/v1/books/{bid}/progress', headers=auth_headers, json={
        'reader_type': 'text', 'chapter_index': 2, 'epub_cfi': 'aisu-scroll:0.4', 'progress_percent': 50})
    assert response.status_code == 200, response.text
    response = client.put(f'/api/v1/books/{bid}/progress', headers=auth_headers, json={'reader_type': 'text', 'progress_percent': 100})
    assert response.status_code == 200 and response.json()['progress_percent'] == 100
