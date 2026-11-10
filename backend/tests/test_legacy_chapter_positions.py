from datetime import datetime, timedelta, timezone
from math import isclose

import pytest

from app.core.config import Settings
from app.modules.reading_progress.domain import ReadingProgress
from app.modules.reading_progress.repository import SqlAlchemyReadingProgressRepository
from app.modules.reader.service import resolve_progress_chapter_position
from test_chapter_progress_reconciliation import upload


def seed_progress(client, bid, reader_type, percent, index=999):
    previous = ReadingProgress(user_id=Settings.default_user_id, book_id=bid, reader_type=reader_type,
        progress_percent=percent, chapter_index=index, epub_cfi='aisu-scroll:0.9',
        chapter_href='obsolete.xhtml', updated_at=datetime.now(timezone.utc) - timedelta(days=1))
    with client.app.state.db_session_factory() as session:
        SqlAlchemyReadingProgressRepository(session).save(previous)
    return previous


@pytest.mark.parametrize('file_ext', ['epub', 'txt'])
@pytest.mark.parametrize('percent', [0, 50, 100])
def test_startup_projects_out_of_range_history_to_a_readable_position_without_rewriting_it(client, auth_headers, file_ext, percent):
    bid = upload(client, auth_headers, file_ext)
    resource = client.get(f'/api/v1/books/{bid}/reader', headers=auth_headers).json()
    previous = seed_progress(client, bid, resource['reader_type'], percent)
    response = client.get(f'/api/v1/books/{bid}/reader/startup', headers=auth_headers)
    assert response.status_code == 200, response.text
    data = response.json()
    index, ratio = resolve_progress_chapter_position(percent, [item['progress_weight'] for item in resource['toc']])
    assert data['chapter'] is not None, 'continuing a book must preload an existing chapter'
    assert data['chapter']['index'] == data['progress']['chapter_index'] == index
    assert data['chapter']['position_key'] == resource['toc'][index - 1]['position_key']
    assert isclose(float(data['progress']['epub_cfi'].removeprefix('aisu-scroll:')), ratio, abs_tol=1e-9)
    assert data['progress']['chapter_href'] is None
    assert data['progress']['progress_percent'] == percent
    assert datetime.fromisoformat(data['progress']['updated_at'].replace('Z', '+00:00')) == previous.updated_at
    assert data['book']['current_chapter'] == f'第 {index} 章'
    with client.app.state.db_session_factory() as session:
        assert SqlAlchemyReadingProgressRepository(session).get(Settings.default_user_id, bid) == previous


@pytest.mark.parametrize('file_ext', ['epub', 'txt'])
@pytest.mark.parametrize('deleted', [1, 2, 4])
@pytest.mark.parametrize('percent', [0, 50, 100])
def test_delete_repairs_an_out_of_range_legacy_position_using_its_previous_percentage(client, auth_headers, file_ext, deleted, percent):
    bid = upload(client, auth_headers, file_ext)
    resource = client.get(f'/api/v1/books/{bid}/reader', headers=auth_headers).json()
    previous = seed_progress(client, bid, resource['reader_type'], percent)
    index, ratio = resolve_progress_chapter_position(percent, [item['progress_weight'] for item in resource['toc']])
    response = client.delete(f'/api/v1/books/{bid}/chapters/{deleted}', headers=auth_headers)
    assert response.status_code == 200, response.text
    next_index = index - 1 if index > deleted else index
    if index == deleted:
        next_index, ratio = min(deleted, 3), 0 if deleted <= 3 else 1
    data = client.get(f'/api/v1/books/{bid}/reader/startup', headers=auth_headers).json()
    assert data['chapter'] is not None
    assert data['progress']['chapter_index'] == data['chapter']['index'] == next_index
    assert isclose(float(data['progress']['epub_cfi'].removeprefix('aisu-scroll:')), ratio, abs_tol=1e-9)
    assert data['progress']['chapter_href'] is None
    assert datetime.fromisoformat(data['progress']['updated_at'].replace('Z', '+00:00')) == previous.updated_at
    if percent == 100:
        assert data['progress']['progress_percent'] == 100
    with client.app.state.db_session_factory() as session:
        stored = SqlAlchemyReadingProgressRepository(session).get(Settings.default_user_id, bid)
        assert stored.chapter_index == next_index and stored.chapter_href is None
        assert isclose(float(stored.epub_cfi.removeprefix('aisu-scroll:')), ratio, abs_tol=1e-9)
        assert stored.updated_at == previous.updated_at


@pytest.mark.parametrize('file_ext', ['epub', 'txt'])
def test_unkeyed_client_cannot_store_a_nonexistent_chapter_but_can_save_legacy_and_manual_progress(client, auth_headers, file_ext):
    bid = upload(client, auth_headers, file_ext)
    reader_type = 'epub' if file_ext == 'epub' else 'text'
    valid = {'reader_type': reader_type, 'progress_percent': 50, 'chapter_index': 2, 'epub_cfi': 'aisu-scroll:0.5'}
    assert client.put(f'/api/v1/books/{bid}/progress', headers=auth_headers, json=valid).status_code == 200
    before = client.get(f'/api/v1/books/{bid}/progress', headers=auth_headers).json()
    invalid = client.put(f'/api/v1/books/{bid}/progress', headers=auth_headers, json={**valid, 'chapter_index': 999})
    assert invalid.status_code == 409, invalid.text
    assert client.get(f'/api/v1/books/{bid}/progress', headers=auth_headers).json() == before
    manual = client.put(f'/api/v1/books/{bid}/progress', headers=auth_headers, json={'reader_type': reader_type, 'progress_percent': 100})
    assert manual.status_code == 200 and manual.json()['progress_percent'] == 100


def test_explicit_startup_selection_and_existing_valid_anchor_remain_authoritative(client, auth_headers):
    bid = upload(client, auth_headers, 'epub')
    seed_progress(client, bid, 'epub', 50)
    data = client.get(f'/api/v1/books/{bid}/reader/startup?chapter_index=3', headers=auth_headers).json()
    assert data['chapter']['index'] == 3
    assert 1 <= data['progress']['chapter_index'] <= 4
    valid = seed_progress(client, bid, 'epub', 50, index=3)
    data = client.get(f'/api/v1/books/{bid}/reader/startup', headers=auth_headers).json()
    assert data['chapter']['index'] == 3
    assert data['progress']['epub_cfi'] == valid.epub_cfi and data['progress']['chapter_href'] == valid.chapter_href
