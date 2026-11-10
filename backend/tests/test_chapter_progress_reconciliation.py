from dataclasses import replace
from datetime import datetime, timedelta, timezone
from math import floor

import pytest

from app.core.config import Settings
from app.modules.reading_progress.domain import ReadingProgress
from app.modules.reading_progress.repository import SqlAlchemyReadingProgressRepository
from app.modules.users.models import UserRecord
from test_reader import make_epub_with_documents


def upload(client, headers, file_ext):
    documents = [(f'第{i + 1}话', character * count) for i, (character, count) in enumerate(
        [('甲', 100), ('乙', 1600), ('丙', 100), ('丁', 100)])]
    content = make_epub_with_documents(documents) if file_ext == 'epub' else '\n\n'.join(
        f'第{i + 1}章 标题\n\n{body}' for i, (_, body) in enumerate(documents)).encode()
    response = client.post('/api/v1/uploads/books', headers=headers,
        files={'file': ('weighted.' + file_ext, content, 'application/epub+zip' if file_ext == 'epub' else 'text/plain')})
    assert response.status_code == 200, response.text
    return response.json()['book_id']


def saved(client, book_id, reader_type, index, ratio, *, percent=60):
    progress = ReadingProgress(user_id=Settings.default_user_id, book_id=book_id, reader_type=reader_type,
        chapter_index=index, epub_cfi=f'aisu-scroll:{ratio}', chapter_href=f'chapter-{index}.xhtml',
        progress_percent=percent, updated_at=datetime.now(timezone.utc) + timedelta(minutes=1))
    with client.app.state.db_session_factory() as session:
        SqlAlchemyReadingProgressRepository(session).save(progress)
    return progress


def assert_visible(client, headers, book_id, expected, timestamp):
    for book in [client.get(f'/api/v1/books/{book_id}', headers=headers).json(),
                 next(item for item in client.get('/api/v1/books', headers=headers, params={'page_size': 100}).json()['items'] if item['id'] == book_id)]:
        assert book['progress_percent'] == expected
        assert datetime.fromisoformat(book['updated_at'].replace('Z', '+00:00')) == timestamp


@pytest.mark.parametrize('file_ext', ['epub', 'txt'])
@pytest.mark.parametrize('deleted,index,ratio,next_index,next_ratio', [
    (1, 2, .75, 1, .75), (3, 2, .75, 2, .75), (2, 2, .75, 2, 0), (4, 4, .4, 3, 1), (4, 3, .99, 3, .99),
])
def test_delete_reconciles_weighted_position_without_a_fake_read_event(client, auth_headers, file_ext, deleted, index, ratio, next_index, next_ratio):
    bid = upload(client, auth_headers, file_ext)
    before = client.get(f'/api/v1/books/{bid}/reader', headers=auth_headers).json()
    prior = saved(client, bid, before['reader_type'], index, ratio)
    response = client.delete(f'/api/v1/books/{bid}/chapters/{deleted}', headers=auth_headers)
    assert response.status_code == 200, response.text
    resource = client.get(f'/api/v1/books/{bid}/reader', headers=auth_headers).json()
    weights = [item['progress_weight'] for item in resource['toc']]
    raw = (sum(weights[:next_index - 1]) + weights[next_index - 1] * next_ratio) / sum(weights) * 100
    expected = 100 if next_index == len(weights) and next_ratio == 1 else min(99, max(0, floor(raw + .5)))
    progress = client.get(f'/api/v1/books/{bid}/progress', headers=auth_headers).json()
    assert progress['chapter_index'] == next_index
    assert float(progress['epub_cfi'].removeprefix('aisu-scroll:')) == next_ratio
    assert progress['progress_percent'] == expected
    assert datetime.fromisoformat(progress['updated_at'].replace('Z', '+00:00')) == prior.updated_at
    assert_visible(client, auth_headers, bid, expected, prior.updated_at)
    startup = client.get(f'/api/v1/books/{bid}/reader/startup', headers=auth_headers).json()
    assert startup['chapter']['position_key'] == resource['toc'][next_index - 1]['position_key']
    assert startup['progress']['progress_percent'] == expected
    if deleted != index:
        assert resource['toc'][next_index - 1]['position_key'] == before['toc'][index - 1]['position_key']


@pytest.mark.parametrize('file_ext', ['epub', 'txt'])
def test_edit_reweights_saved_progress_but_keeps_chapter_offset_and_time(client, auth_headers, file_ext):
    bid = upload(client, auth_headers, file_ext)
    reader_type = client.get(f'/api/v1/books/{bid}/reader', headers=auth_headers).json()['reader_type']
    prior = saved(client, bid, reader_type, 2, .5)
    response = client.put(f'/api/v1/books/{bid}/chapters/1', headers=auth_headers,
        json={'title': '第1章 修订', 'content': '新增内容' * 1000})
    assert response.status_code == 200, response.text
    resource = client.get(f'/api/v1/books/{bid}/reader', headers=auth_headers).json()
    weights = [item['progress_weight'] for item in resource['toc']]
    expected = min(99, floor((weights[0] + weights[1] * .5) / sum(weights) * 100 + .5))
    with client.app.state.db_session_factory() as session:
        current = SqlAlchemyReadingProgressRepository(session).get(Settings.default_user_id, bid)
        assert current == replace(prior, progress_percent=expected)
    assert_visible(client, auth_headers, bid, expected, prior.updated_at)


@pytest.mark.parametrize('operation', ['delete', 'edit'])
def test_catalog_changes_preserve_explicit_finished_state(client, auth_headers, operation):
    bid = upload(client, auth_headers, 'epub')
    prior = saved(client, bid, 'epub', 2, .5, percent=100)
    response = client.delete(f'/api/v1/books/{bid}/chapters/1', headers=auth_headers) if operation == 'delete' else client.put(
        f'/api/v1/books/{bid}/chapters/1', headers=auth_headers, json={'title': '第一话', 'content': '改' * 5000})
    assert response.status_code == 200, response.text
    current = client.get(f'/api/v1/books/{bid}/progress', headers=auth_headers).json()
    assert current['progress_percent'] == 100
    assert datetime.fromisoformat(current['updated_at'].replace('Z', '+00:00')) == prior.updated_at


def test_edit_updates_shared_readers_and_preserves_history_from_an_obsolete_format(client, auth_headers):
    bid = upload(client, auth_headers, 'epub')
    at = datetime.now(timezone.utc) - timedelta(days=1)
    records = [ReadingProgress(user_id=uid, book_id=bid, reader_type=reader_type, chapter_index=3,
        epub_cfi='aisu-scroll:0.5', progress_percent=50, updated_at=at) for uid, reader_type in [
        ('shared-reader', 'epub'), ('old-edition-reader', 'text')]]
    with client.app.state.db_session_factory() as session:
        for number, record in enumerate(records, 600001):
            session.add(UserRecord(id=record.user_id, account_number=number, email=f'{record.user_id}@example.local',
                nickname='读者', password_hash='unused', role='user', status='active', created_at=at, updated_at=at))
        session.commit()
        repository = SqlAlchemyReadingProgressRepository(session)
        for record in records:
            repository.save(record)
    response = client.put(f'/api/v1/books/{bid}/chapters/1', headers=auth_headers, json={'title': '第一话', 'content': '改' * 5000})
    assert response.status_code == 200, response.text
    resource = client.get(f'/api/v1/books/{bid}/reader', headers=auth_headers).json()
    weights = [item['progress_weight'] for item in resource['toc']]
    expected = floor((sum(weights[:2]) + weights[2] * .5) / sum(weights) * 100 + .5)
    with client.app.state.db_session_factory() as session:
        repository = SqlAlchemyReadingProgressRepository(session)
        assert repository.get(records[0].user_id, bid) == replace(records[0], progress_percent=expected)
        assert repository.get(records[1].user_id, bid) == records[1]


@pytest.mark.parametrize('operation', ['delete', 'edit'])
def test_failed_publication_restores_the_original_position_percentage_and_time(client, auth_headers, monkeypatch, operation):
    from sqlalchemy.orm import Session
    from app.modules.auth.models import ApiRequestRecord
    bid = upload(client, auth_headers, 'epub')
    prior = saved(client, bid, 'epub', 3, .5)
    native_commit = Session.commit
    def fail_publication(session):
        if any(isinstance(record, ApiRequestRecord) for record in session.new):
            raise RuntimeError('publication rolled back')
        return native_commit(session)
    monkeypatch.setattr(Session, 'commit', fail_publication)
    with pytest.raises(RuntimeError, match='publication rolled back'):
        if operation == 'delete':
            client.delete(f'/api/v1/books/{bid}/chapters/1', headers=auth_headers)
        else:
            client.put(f'/api/v1/books/{bid}/chapters/1', headers=auth_headers, json={'title': '第一话', 'content': '改' * 5000})
    with client.app.state.db_session_factory() as session:
        assert SqlAlchemyReadingProgressRepository(session).get(Settings.default_user_id, bid) == prior
    resource = client.get(f'/api/v1/books/{bid}/reader', headers=auth_headers).json()
    assert len(resource['toc']) == 4 and resource['toc'][0]['progress_weight'] < 5000
