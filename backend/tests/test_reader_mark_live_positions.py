from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.core.config import Settings
from app.modules.book_assets.repository import SqlAlchemyBookAssetRepository
from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.reader_marks.domain import ReaderMark
from app.modules.reader_marks.repository import SqlAlchemyReaderMarkRepository
from test_reader_page_positions import seed_pages, resource
from test_reader_position_writes import seed_chapters


def store_mark(client, reader_type='epub', **coordinates):
    at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    mark = ReaderMark(id=str(uuid4()), user_id=Settings.default_user_id, book_id='b1',
        reader_type=reader_type, kind='note', note='原备注第一行。\n第二行也要保留。', label='我的旁注',
        progress_percent=12, created_at=at, updated_at=at, **coordinates)
    with client.app.state.db_session_factory() as session:
        SqlAlchemyReaderMarkRepository(session).save(mark)
    return mark


def listed(client, auth_headers, original):
    response = client.get('/api/v1/books/b1/marks', headers=auth_headers)
    assert response.status_code == 200, response.text
    public = next(item for item in response.json() if item['id'] == original.id)
    assert public['note'] == original.note and public['label'] == original.label
    assert datetime.fromisoformat(public['updated_at']) == original.updated_at
    with client.app.state.db_session_factory() as session:
        assert SqlAlchemyReaderMarkRepository(session).get(original.user_id, original.id) == original
    return public


@pytest.mark.parametrize('reader_type', ['epub', 'text'])
@pytest.mark.parametrize('coordinates', [
    {'chapter_index': 999}, {'chapter_index': 2, 'position_key': 'missing-chapter'},
    {'chapter_index': 2, 'page_number': 3}, {},
])
def test_impossible_chapter_marks_are_projected_as_unavailable_without_rewriting_notes(client, auth_headers, reader_type, coordinates):
    seed_chapters(client)
    with client.app.state.db_session_factory() as session:
        books = SqlAlchemyBookRepository(session)
        books.save(books.get_by_id('b1').with_changes(reader_type=reader_type))
    original = store_mark(client, reader_type, **coordinates)
    assert listed(client, auth_headers, original)['position_valid'] is False
    startup = client.get('/api/v1/books/b1/reader/startup', headers=auth_headers).json()
    assert next(mark for mark in startup['marks'] if mark['id'] == original.id)['position_valid'] is False


def test_chapter_identity_rebases_a_legacy_mark_even_without_a_scroll_ratio(client, auth_headers):
    chapters = seed_chapters(client)
    original = store_mark(client, chapter_index=999, position_key=chapters[1].id)
    public = listed(client, auth_headers, original)
    assert public['position_valid'] is True and public['chapter_index'] == 2
    assert public['progress_percent'] == original.progress_percent


@pytest.mark.parametrize('reader_type', ['comic', 'image'])
@pytest.mark.parametrize('coordinates', [
    {'image_index': 999}, {'image_index': 2, 'position_key': 'missing-page'},
    {'image_index': 2, 'page_number': 3}, {'chapter_index': 2, 'image_index': 2}, {},
])
def test_impossible_image_page_marks_are_unavailable(client, auth_headers, reader_type, coordinates):
    seed_pages(client, reader_type)
    original = store_mark(client, reader_type, **coordinates)
    assert listed(client, auth_headers, original)['position_valid'] is False


@pytest.mark.parametrize('reader_type', ['comic', 'image'])
def test_page_identity_follows_reordering_without_editing_the_note(client, auth_headers, reader_type):
    seed_pages(client, reader_type)
    data = resource(client, auth_headers)
    original = store_mark(client, reader_type, image_index=2, page_number=2, position_key=data['pages'][1]['position_key'])
    with client.app.state.db_session_factory() as session:
        assets = SqlAlchemyBookAssetRepository(session)
        pages = assets.list_by_book('b1', 'comic_page' if reader_type == 'comic' else 'image_page')
        assets.update_index(pages[0].id, 2)
        assets.update_index(pages[1].id, 1)
    public = listed(client, auth_headers, original)
    assert public['position_valid'] is True and public['image_index'] == public['page_number'] == 1
    assert public['progress_percent'] == 33


@pytest.mark.parametrize('coordinates', [
    {'page_number': 2, 'position_key': 'old-pdf'}, {'page_number': 2, 'chapter_index': 1}, {},
])
def test_old_pdf_or_missing_page_marks_are_unavailable(client, auth_headers, coordinates):
    seed_pages(client, 'pdf')
    original = store_mark(client, 'pdf', **coordinates)
    assert listed(client, auth_headers, original)['position_valid'] is False


def test_other_format_and_already_retired_marks_do_not_become_navigable(client, auth_headers):
    chapters = seed_chapters(client)
    old_format = store_mark(client, 'pdf', page_number=1)
    retired = store_mark(client, chapter_index=2, position_key=chapters[1].id, position_valid=False)
    assert listed(client, auth_headers, old_format)['position_valid'] is False
    assert listed(client, auth_headers, retired)['position_valid'] is False


def test_explicit_relocation_restores_navigation_and_keeps_note_content(client, auth_headers):
    chapters = seed_chapters(client)
    original = store_mark(client, chapter_index=999, position_key='missing-chapter')
    response = client.put(f'/api/v1/books/b1/marks/{original.id}/position', headers=auth_headers, json={
        'reader_type': 'epub', 'chapter_index': 2, 'position_key': chapters[1].id,
        'epub_cfi': 'aisu-scroll:0.5', 'progress_percent': 100})
    assert response.status_code == 200, response.text
    public = response.json()
    assert public['position_valid'] is True and public['chapter_index'] == 2
    assert public['note'] == original.note and public['label'] == original.label
    assert public['progress_percent'] == 50
