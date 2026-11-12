from datetime import datetime, timedelta, timezone
from math import floor
from pathlib import Path
from uuid import uuid4

import pytest
from dataclasses import replace
from sqlalchemy import select

from app.core.config import Settings
from app.modules.book_assets.repository import SqlAlchemyBookAssetRepository, create_book_asset
from app.modules.reading_progress.domain import ReadingProgress
from app.modules.reading_progress.repository import InMemoryReadingProgressRepository, SqlAlchemyReadingProgressRepository
from app.modules.reading_progress.models import ReadingProgressRecord
from app.modules.users.models import UserRecord
from app.modules.books.models import BookRecord
from app.modules.translations.epub import append_translation_epub
from test_uploads import make_minimal_epub_bytes


def catalog(client, count=198):
    with client.app.state.db_session_factory() as session:
        assets = SqlAlchemyBookAssetRepository(session)
        assets.clear_for_book('b2')
        chapters = [create_book_asset(book_id='b2', asset_type='text_chapter', index=i + 1,
            path=f'progress-fixture/chapter-{i + 1}.txt',
            metadata={'title': f'第{i + 1}话', 'text_length': 1000 if i < 120 else 1800}) for i in range(count)]
        assets.save_many(chapters)
        SqlAlchemyReadingProgressRepository(session).delete_for_book(Settings.default_user_id, 'b2')
    return chapters


@pytest.mark.parametrize('keyed', [True, False])
def test_old_reader_cannot_report_finished_against_an_expanded_catalog(client, auth_headers, keyed):
    chapters = catalog(client)
    payload = {'reader_type': 'epub', 'chapter_index': 121, 'epub_cfi': 'aisu-scroll:0.16',
        'progress_percent': 100,
        'updated_at': datetime.now(timezone.utc).isoformat()}
    if keyed:
        payload['position_key'] = chapters[120].id
    response = client.put('/api/v1/books/b2/progress', headers=auth_headers, json=payload)
    assert response.status_code == 200, response.text
    assert response.json()['progress_percent'] == 46
    assert response.json()['chapter_index'] == 121 and response.json()['epub_cfi'] == payload['epub_cfi']
    assert client.get('/api/v1/books/b2/progress', headers=auth_headers).json()['progress_percent'] == 46
    assert client.get('/api/v1/books/b2', headers=auth_headers).json()['progress_percent'] == 46


@pytest.mark.parametrize('epub_cfi', [None, 'epubcfi(/6/2[chapter-121]!/4/2)'])
def test_legacy_chapter_position_without_scroll_marker_cannot_report_finished(client, auth_headers, epub_cfi):
    chapters = catalog(client)
    payload = {
        'reader_type': 'epub', 'chapter_index': 121, 'position_key': chapters[120].id,
        'progress_percent': 100, 'updated_at': datetime.now(timezone.utc).isoformat(),
    }
    if epub_cfi is not None:
        payload['epub_cfi'] = epub_cfi
    response = client.put('/api/v1/books/b2/progress', headers=auth_headers, json=payload)
    assert response.status_code == 200, response.text
    assert 0 < response.json()['progress_percent'] < 100


def test_small_saved_position_stays_in_progress_without_inflating_the_percentage(client, auth_headers):
    chapters = catalog(client)
    saved = client.put('/api/v1/books/b2/progress', headers=auth_headers, json={
        'reader_type': 'epub', 'chapter_index': 1, 'position_key': chapters[0].id,
        'epub_cfi': 'aisu-scroll:0.01', 'progress_percent': 0,
        'updated_at': datetime.now(timezone.utc).isoformat()})
    assert saved.status_code == 200, saved.text
    assert saved.json()['progress_percent'] == 0
    assert saved.json()['epub_cfi'] == 'aisu-scroll:0.01'
    recent = client.get('/api/v1/books', headers=auth_headers, params={'shelf': 'recent'}).json()
    book = next(item for item in recent['items'] if item['id'] == 'b2')
    assert book['progress_percent'] == 0 and book['last_read_at'] is not None
    unread = client.get('/api/v1/books', headers=auth_headers, params={'shelf': 'unread'}).json()
    assert all(item['id'] != 'b2' for item in unread['items'])


def test_manual_completion_still_keeps_its_position_and_explicit_finished_state(client, auth_headers):
    chapters = catalog(client)
    client.put('/api/v1/books/b2/progress', headers=auth_headers, json={
        'reader_type': 'epub', 'chapter_index': 121, 'epub_cfi': 'aisu-scroll:0.16',
        'position_key': chapters[120].id, 'progress_percent': 46,
        'updated_at': datetime.now(timezone.utc).isoformat()})
    response = client.put('/api/v1/books/b2/reading-status', headers=auth_headers, json={'finished': True})
    assert response.status_code == 200, response.text
    progress = client.get('/api/v1/books/b2/progress', headers=auth_headers).json()
    assert progress['progress_percent'] == 100 and progress['chapter_index'] == 121
    assert progress['epub_cfi'] == 'aisu-scroll:0.16'


def test_percentage_only_api_progress_remains_an_explicit_manual_change(client, auth_headers):
    catalog(client)
    response = client.put('/api/v1/books/b2/progress', headers=auth_headers, json={
        'reader_type': 'epub', 'progress_percent': 100, 'updated_at': datetime.now(timezone.utc).isoformat()})
    assert response.status_code == 200 and response.json()['progress_percent'] == 100


def test_legacy_scroll_progress_without_an_extracted_catalog_is_preserved(client, auth_headers):
    catalog(client, count=0)
    response = client.put('/api/v1/books/b2/progress', headers=auth_headers, json={
        'reader_type': 'epub', 'chapter_index': 2, 'epub_cfi': 'aisu-scroll:0.5',
        'progress_percent': 37, 'updated_at': datetime.now(timezone.utc).isoformat()})
    assert response.status_code == 200, response.text
    assert response.json()['progress_percent'] == 37
    assert response.json()['chapter_index'] == 2 and response.json()['epub_cfi'] == 'aisu-scroll:0.5'


@pytest.mark.parametrize('endpoint', ['continuation', 'chapters'])
def test_api_append_rebases_all_readers_using_current_chapter_weights(client, auth_headers, endpoint):
    uploaded = client.post('/api/v1/uploads/books', headers=auth_headers,
        files={'file': ('weighted.epub', make_minimal_epub_bytes(chapter_texts=['甲' * 100, '乙' * 100]), 'application/epub+zip')})
    assert uploaded.status_code == 200, uploaded.text
    bid = uploaded.json()['book_id']
    now = datetime.now(timezone.utc)
    with client.app.state.db_session_factory() as session:
        session.add(UserRecord(id='append-reader', account_number=987654, email='append-reader@example.local',
            nickname='读者', password_hash='test-only', role='user', status='active', created_at=now, updated_at=now))
        session.commit()
        progresses = SqlAlchemyReadingProgressRepository(session)
        for uid, index, percent in [(Settings.default_user_id, 2, 75), ('append-reader', 1, 25)]:
            progresses.save(ReadingProgress(user_id=uid, book_id=bid, reader_type='epub', progress_percent=percent,
                chapter_index=index, epub_cfi='aisu-scroll:0.5',
                updated_at=now + timedelta(minutes=2) if uid == 'append-reader' else now - timedelta(minutes=1)))
    state = client.get(f'/api/v1/books/{bid}/continuation', headers=auth_headers).json()
    payload = {
        'request_id': str(uuid4()), 'expected_revision': state['revision'],
        'chapters': [{'title': '第三话', 'content': '新' * 500}]}
    response = client.post(f'/api/v1/books/{bid}/{endpoint}', headers=auth_headers,
        json=payload if endpoint == 'continuation' else payload['chapters'][0])
    assert response.status_code == 200, response.text
    resource = client.get(f'/api/v1/books/{bid}/reader', headers=auth_headers).json()
    weights = [c['progress_weight'] for c in resource['toc']]
    with client.app.state.db_session_factory() as session:
        progresses = SqlAlchemyReadingProgressRepository(session)
        for uid, index in [(Settings.default_user_id, 2), ('append-reader', 1)]:
            saved = progresses.get(uid, bid)
            expected = floor((sum(weights[:index - 1]) + weights[index - 1] * .5) / sum(weights) * 100 + .5)
            assert saved.progress_percent == expected
            assert saved.chapter_index == index and saved.epub_cfi == 'aisu-scroll:0.5'
            read_at = now + timedelta(minutes=2) if uid == 'append-reader' else now - timedelta(minutes=1)
            assert saved.updated_at == read_at
    detail = client.get(f'/api/v1/books/{bid}', headers=auth_headers).json()
    shelf = client.get('/api/v1/books', headers=auth_headers, params={'q': 'weighted', 'shelf': 'recent'}).json()
    listed = next(item for item in shelf['items'] if item['id'] == bid)
    for item in [detail, listed]:
        assert item['progress_percent'] == floor((weights[0] + weights[1] * .5) / sum(weights) * 100 + .5)
        assert datetime.fromisoformat(item['updated_at'].replace('Z', '+00:00')) == now - timedelta(minutes=1)


def test_append_does_not_turn_an_old_unread_state_into_a_new_reset(client, auth_headers):
    uploaded = client.post('/api/v1/uploads/books', headers=auth_headers,
        files={'file': ('offline.epub', make_minimal_epub_bytes(chapter_texts=['甲' * 100, '乙' * 100]), 'application/epub+zip')})
    assert uploaded.status_code == 200, uploaded.text
    bid = uploaded.json()['book_id']
    read_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    with client.app.state.db_session_factory() as session:
        SqlAlchemyReadingProgressRepository(session).save(ReadingProgress(user_id=Settings.default_user_id,
            book_id=bid, reader_type='epub', progress_percent=0, updated_at=read_at - timedelta(days=1)))
    resource = client.get(f'/api/v1/books/{bid}/reader', headers=auth_headers).json()
    state = client.get(f'/api/v1/books/{bid}/continuation', headers=auth_headers).json()
    appended = client.post(f'/api/v1/books/{bid}/continuation', headers=auth_headers, json={
        'request_id': str(uuid4()), 'expected_revision': state['revision'],
        'chapters': [{'title': '第三话', 'content': '新' * 500}]})
    assert appended.status_code == 200, appended.text
    offline = client.put(f'/api/v1/books/{bid}/progress', headers=auth_headers, json={
        'reader_type': 'epub', 'chapter_index': 1, 'position_key': resource['toc'][0]['position_key'],
        'epub_cfi': 'aisu-scroll:0.5', 'progress_percent': 25, 'updated_at': read_at.isoformat()})
    assert offline.status_code == 200, offline.text
    saved = offline.json()
    assert saved['progress_percent'] > 0 and saved['chapter_index'] == 1
    assert saved['epub_cfi'] == 'aisu-scroll:0.5'
    assert datetime.fromisoformat(saved['updated_at'].replace('Z', '+00:00')) == read_at


@pytest.mark.parametrize('change', ['read', 'reset', 'delete'])
@pytest.mark.parametrize('storage', ['sql', 'memory'])
def test_catalog_rebase_cannot_overwrite_a_concurrent_read_reset_or_deletion(client, change, storage):
    now = datetime.now(timezone.utc)
    previous = ReadingProgress(user_id=Settings.default_user_id, book_id='b2', reader_type='epub',
        chapter_index=121, epub_cfi='aisu-scroll:0.16', progress_percent=100, updated_at=now)
    newer = replace(previous, chapter_index=122, epub_cfi='aisu-scroll:0.8', progress_percent=47,
        updated_at=now + timedelta(seconds=1)) if change == 'read' else replace(previous,
        chapter_index=None, epub_cfi=None, progress_percent=0, updated_at=now + timedelta(seconds=1))
    with client.app.state.db_session_factory() as session:
        repository = SqlAlchemyReadingProgressRepository(session) if storage == 'sql' else InMemoryReadingProgressRepository()
        repository.save(previous)
        previous = repository.get(Settings.default_user_id, 'b2')
        cached = session.scalar(select(ReadingProgressRecord).where(ReadingProgressRecord.book_id == 'b2',
            ReadingProgressRecord.user_id == Settings.default_user_id)) if storage == 'sql' else None
        if storage == 'sql':
            with client.app.state.db_session_factory() as other:
                writer = SqlAlchemyReadingProgressRepository(other)
                if change == 'delete':
                    writer.delete_for_book(Settings.default_user_id, 'b2')
                else:
                    writer.save(newer)
        elif change == 'delete':
            repository.delete_for_book(Settings.default_user_id, 'b2')
        else:
            repository.save(newer)
        repository.rebase_percentage(previous, 46)
        assert repository.get(Settings.default_user_id, 'b2') == (None if change == 'delete' else newer)
        if cached is not None and change != 'delete':
            assert cached.chapter_index == newer.chapter_index


def test_catalog_rebase_rolls_back_with_its_publication_transaction(client):
    now = datetime.now(timezone.utc)
    saved = ReadingProgress(user_id=Settings.default_user_id, book_id='b2', reader_type='epub',
        chapter_index=121, epub_cfi='aisu-scroll:0.16', progress_percent=100, updated_at=now)
    with client.app.state.db_session_factory() as session:
        SqlAlchemyReadingProgressRepository(session).save(saved)
        transaction = SqlAlchemyReadingProgressRepository(session, autocommit=False)
        transaction.rebase_percentage(saved, 46)
        assert transaction.get(Settings.default_user_id, 'b2') == replace(saved, progress_percent=46)
        session.rollback()
        assert transaction.get(Settings.default_user_id, 'b2') == saved


@pytest.mark.parametrize('index,ratio,expected', [(197, 1, 99), (198, .999, 99), (198, 1, 100), (1, 0, 0)])
@pytest.mark.parametrize('keyed', [True, False])
def test_only_actual_end_of_current_catalog_is_finished(client, auth_headers, index, ratio, expected, keyed):
    chapters = catalog(client)
    payload = {
        'reader_type': 'epub', 'chapter_index': index, 'epub_cfi': f'aisu-scroll:{ratio}',
        'progress_percent': 100, 'updated_at': datetime.now(timezone.utc).isoformat()}
    if keyed:
        payload['position_key'] = chapters[index - 1].id
    response = client.put('/api/v1/books/b2/progress', headers=auth_headers, json=payload)
    assert response.status_code == 200, response.text
    assert response.json()['progress_percent'] == expected


@pytest.mark.parametrize('unchanged_prefix', [True, False])
@pytest.mark.parametrize('entrypoint', ['api', 'direct', 'direct_legacy_timestamp'])
def test_reprocessing_an_externally_appended_epub_rebases_only_a_verified_prefix(client, auth_headers, unchanged_prefix, entrypoint):
    from pathlib import Path
    uploaded = client.post('/api/v1/uploads/books', headers=auth_headers,
        files={'file': ('external.epub', make_minimal_epub_bytes(chapter_texts=['甲' * 100, '乙' * 100]), 'application/epub+zip')})
    assert uploaded.status_code == 200, uploaded.text
    bid = uploaded.json()['book_id']
    with client.app.state.db_session_factory() as session:
        SqlAlchemyReadingProgressRepository(session).save(ReadingProgress(user_id=Settings.default_user_id,
            book_id=bid, reader_type='epub', progress_percent=100, chapter_index=2, epub_cfi='aisu-scroll:1',
            updated_at=datetime.now(timezone.utc)))
        book = session.get(BookRecord, bid)
        original = Path(client.app.state.settings.storage_root, book.original_file_path)
        prefix = original.read_bytes() if unchanged_prefix else make_minimal_epub_bytes(chapter_texts=['改' * 100, '乙' * 100])
        original.write_bytes(append_translation_epub(original_epub=prefix,
            chapters=[{'index': 3, 'title': '第三话', 'paragraphs': ['新' * 500]}]))
    if entrypoint == 'api':
        response = client.post(f'/api/v1/uploads/books/{bid}/reprocess', headers=auth_headers)
        assert response.status_code == 200, response.text
    else:
        from app.modules.books.repository import SqlAlchemyBookRepository
        from app.modules.processing.service import process_uploaded_book
        with client.app.state.db_session_factory() as session:
            if entrypoint == 'direct_legacy_timestamp':
                saved = SqlAlchemyReadingProgressRepository(session).get(Settings.default_user_id, bid)
                session.connection().exec_driver_sql(
                    'UPDATE reading_progress SET updated_at = ? WHERE book_id = ?',
                    (saved.updated_at.isoformat(), bid),
                )
                session.commit()
            books = SqlAlchemyBookRepository(session)
            process_uploaded_book(book=books.get_owned(Settings.default_user_id, bid),
                book_repository=books, asset_repository=SqlAlchemyBookAssetRepository(session),
                should_update_author=False, should_update_title=False, settings=client.app.state.settings)
    resource = client.get(f'/api/v1/books/{bid}/reader', headers=auth_headers).json()
    weights = [item['progress_weight'] for item in resource['toc']]
    progress = client.get(f'/api/v1/books/{bid}/progress', headers=auth_headers).json()
    expected = floor(sum(weights[:2]) / sum(weights) * 100 + .5) if unchanged_prefix else 100
    assert progress['progress_percent'] == expected
    assert progress['chapter_index'] == 2 and progress['epub_cfi'] == 'aisu-scroll:1'
    detail = client.get(f'/api/v1/books/{bid}', headers=auth_headers).json()
    assert detail['progress_percent'] == expected
    finished = client.get('/api/v1/books', headers=auth_headers, params={'shelf': 'finished'}).json()['items']
    assert any(item['id'] == bid for item in finished) is (not unchanged_prefix)


def test_direct_processing_preserves_source_position_when_translation_is_revised_and_extended(client, auth_headers):
    from app.modules.books.repository import SqlAlchemyBookRepository
    from app.modules.processing.service import process_uploaded_book
    from app.modules.translations.epub import build_translation_epub

    source = 'https://kakuyomu.jp/works/123/episodes/1'
    first = {'index': 1, 'title': '第一话', 'source_url': source, 'paragraphs': ['旧' * 100]}
    data = build_translation_epub(title='续译', author='作者', description='', source_url='https://kakuyomu.jp/works/123', chapters=[first])
    uploaded = client.post('/api/v1/uploads/books', headers=auth_headers,
        files={'file': ('source.epub', data, 'application/epub+zip')})
    assert uploaded.status_code == 200, uploaded.text
    bid = uploaded.json()['book_id']
    read_at = datetime.now(timezone.utc) - timedelta(hours=1)
    with client.app.state.db_session_factory() as session:
        SqlAlchemyReadingProgressRepository(session).save(ReadingProgress(user_id=Settings.default_user_id,
            book_id=bid, reader_type='epub', chapter_index=1, epub_cfi='aisu-scroll:1',
            progress_percent=100, updated_at=read_at))
        books = SqlAlchemyBookRepository(session)
        book = books.get_owned(Settings.default_user_id, bid)
        Path(client.app.state.settings.storage_root, book.original_file_path).write_bytes(build_translation_epub(
            title='续译', author='作者', description='', source_url='https://kakuyomu.jp/works/123',
            chapters=[{**first, 'paragraphs': ['修' * 200]},
                      {'index': 2, 'title': '第二话', 'source_url': 'https://kakuyomu.jp/works/123/episodes/2', 'paragraphs': ['新' * 300]}]))
        process_uploaded_book(book=book, book_repository=books, asset_repository=SqlAlchemyBookAssetRepository(session),
            should_update_author=False, should_update_title=False, settings=client.app.state.settings)
    current = client.get(f'/api/v1/books/{bid}/progress', headers=auth_headers).json()
    assert 0 < current['progress_percent'] < 100
    assert current['chapter_index'] == 1 and current['epub_cfi'] == 'aisu-scroll:1'
    assert datetime.fromisoformat(current['updated_at'].replace('Z', '+00:00')) == read_at
