from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.modules.books.factory import create_uploaded_book
from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.reading_progress.domain import ReadingProgress
from app.modules.reading_progress.repository import SqlAlchemyReadingProgressRepository
from app.modules.users.models import UserRecord


def add_book(client, book_id, *, reader_type='pdf', percent=0, age_hours=2):
    owner = client.app.state.settings.default_user_id
    now = datetime.now(timezone.utc)
    with client.app.state.db_session_factory() as session:
        SqlAlchemyBookRepository(session).save(create_uploaded_book(
            author='Test', book_id=book_id, file_label='Test', kind='pdf' if reader_type == 'pdf' else 'novel',
            owner_id=owner, reader_type=reader_type, tags=(), title='Format audit ' + book_id,
        ).with_changes(status='ready', progress_percent=percent, updated_at=now - timedelta(hours=age_hours)))


def add_progress(client, book_id, *, reader_type='epub', percent=100, age_hours=-1, **position):
    with client.app.state.db_session_factory() as session:
        SqlAlchemyReadingProgressRepository(session).save(ReadingProgress(
            user_id=client.app.state.settings.default_user_id, book_id=book_id,
            reader_type=reader_type, progress_percent=percent,
            updated_at=datetime.now(timezone.utc) - timedelta(hours=age_hours),
            **position,
        ))


def shelf(client, headers, kind='all', *, sort='recent', page_size=100, page=1):
    response = client.get('/api/v1/books', headers=headers, params={
        'q': 'Format audit', 'shelf': kind, 'sort': sort, 'page_size': page_size, 'page': page,
    })
    assert response.status_code == 200
    return response.json()


@pytest.mark.parametrize('reader_type', ['text', 'epub', 'pdf', 'comic', 'image'])
@pytest.mark.parametrize('old_percent', [45, 100])
def test_replaced_format_is_unread_in_both_filter_and_display(client: TestClient, auth_headers, reader_type, old_percent):
    add_book(client, 'changed', reader_type=reader_type, percent=77)
    add_progress(client, 'changed', reader_type='epub' if reader_type != 'epub' else 'pdf', percent=old_percent)
    unread = shelf(client, auth_headers, 'unread')
    assert unread['total'] == 1
    assert unread['items'][0]['id'] == 'changed'
    assert unread['items'][0]['progress_percent'] == 0
    for kind in ['recent', 'finished']:
        assert shelf(client, auth_headers, kind)['total'] == 0


def test_overview_counts_and_continue_candidate_agree_with_visible_progress(client: TestClient, auth_headers):
    add_book(client, 'changed-finished', percent=100)
    add_progress(client, 'changed-finished', percent=100)
    add_book(client, 'changed-reading', percent=45)
    add_progress(client, 'changed-reading', percent=45)
    all_books = client.get('/api/v1/books?shelf=all&page_size=100', headers=auth_headers).json()['items']
    response = client.get('/api/v1/books/overview?recent_limit=24&include_labels=false', headers=auth_headers)
    assert response.status_code == 200
    overview = response.json()
    assert overview['in_progress_count'] == sum(0 < book['progress_percent'] < 100 for book in all_books)
    assert overview['finished_count'] == sum(book['progress_percent'] == 100 for book in all_books)
    assert overview['continue_book']['id'] not in {'changed-finished', 'changed-reading'}
    assert 0 < overview['continue_book']['progress_percent'] < 100


@pytest.mark.parametrize('old_percent', [0, 45, 100])
def test_progress_sort_and_recent_order_ignore_old_format_history(client: TestClient, auth_headers, old_percent):
    add_book(client, 'changed', percent=100, age_hours=3)
    add_progress(client, 'changed', percent=old_percent)
    add_book(client, 'unread', age_hours=1)
    add_book(client, 'reading', age_hours=5)
    add_progress(client, 'reading', reader_type='pdf', percent=45, age_hours=2)
    recent = shelf(client, auth_headers)
    assert [book['id'] for book in recent['items']] == ['reading', 'unread', 'changed']
    progress = shelf(client, auth_headers, sort='progress')
    assert progress['items'][0]['id'] == 'reading'
    for page in [1, 2]:
        result = shelf(client, auth_headers, 'unread', page=page, page_size=1)
        assert result['total'] == 2
        assert result['items'][0]['id'] == ('unread' if page == 1 else 'changed')


def test_overview_limit_does_not_choose_replaced_format_as_continue_book(client: TestClient, auth_headers):
    # A recent obsolete position must not crowd the genuine active read out
    # before the service overlays progress on this bounded SQL result.
    add_book(client, 'changed', percent=80)
    add_progress(client, 'changed', percent=80)
    add_book(client, 'reading', age_hours=5)
    add_progress(client, 'reading', reader_type='pdf', percent=45, age_hours=-0.5)
    response = client.get('/api/v1/books/overview?recent_limit=1&include_labels=false', headers=auth_headers)
    assert response.status_code == 200
    overview = response.json()
    assert len(overview['items']) == 1
    assert overview['items'][0]['id'] == overview['continue_book']['id'] == 'reading'
    assert overview['continue_book']['progress_percent'] == 45


def test_absent_progress_keeps_book_default_and_other_account_history_is_ignored(client: TestClient, auth_headers):
    add_book(client, 'default-finished', percent=100)
    add_book(client, 'default-reading', percent=45)
    add_book(client, 'default-unread')
    # The owner's status must never join another viewer's progress row.
    with client.app.state.db_session_factory() as session:
        now = datetime.now(timezone.utc)
        session.add(UserRecord(
            id='another-reader', account_number=100, email='reader@example.test', password_hash='test-only',
            nickname='Reader', created_at=now, updated_at=now,
        ))
        session.commit()
        SqlAlchemyReadingProgressRepository(session).save(ReadingProgress(
            user_id='another-reader', book_id='default-unread', reader_type='pdf', progress_percent=100,
        ))
    assert [book['id'] for book in shelf(client, auth_headers, 'finished')['items']] == ['default-finished']
    assert [book['id'] for book in shelf(client, auth_headers, 'recent')['items']] == ['default-reading']
    assert [book['id'] for book in shelf(client, auth_headers, 'unread')['items']] == ['default-unread']


@pytest.mark.parametrize('reader_type,position,label', [
    ('text', {'chapter_index': 6}, '第 6 章'),
    ('epub', {'chapter_index': 6}, '第 6 章'),
    ('pdf', {'page_number': 6}, '第 6 页'),
    ('comic', {'image_index': 6}, '第 6 页'),
    ('image', {'image_index': 6}, '第 6 页'),
])
def test_saved_position_label_matches_progress_in_shelf_detail_and_home(client: TestClient, auth_headers, reader_type, position, label):
    add_book(client, 'reading', reader_type=reader_type)
    add_progress(client, 'reading', reader_type=reader_type, percent=45, **position)
    books = shelf(client, auth_headers, 'recent')['items']
    assert books[0]['current_chapter'] == label
    detail = client.get('/api/v1/books/reading', headers=auth_headers)
    assert detail.status_code == 200
    assert detail.json()['current_chapter'] == label
    overview = client.get('/api/v1/books/overview?include_labels=false', headers=auth_headers)
    assert overview.status_code == 200
    assert overview.json()['continue_book']['id'] == 'reading'
    assert overview.json()['continue_book']['current_chapter'] == label
