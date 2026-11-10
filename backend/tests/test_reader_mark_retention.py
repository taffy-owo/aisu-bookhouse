from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update

from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.reader_marks.models import ReaderMarkRecord
from app.modules.uploads.replacement_publication import retire_reader_mark_positions
from test_reader_page_positions import seed_pages, resource, payload_for
from test_reader_position_writes import seed_chapters, change_chapters

from test_uploads import make_minimal_epub_bytes


@pytest.mark.parametrize("keep_progress", [True, False])
def test_replacement_preserves_mark_content(client: TestClient, auth_headers, keep_progress):
    uploaded = client.post('/api/v1/uploads/books', headers=auth_headers,
                           files={'file': ('old.epub', BytesIO(make_minimal_epub_bytes(chapter_text='Old text')), 'application/epub+zip')})
    assert uploaded.status_code == 200
    book_id = uploaded.json()['book_id']
    original = client.post(f'/api/v1/books/{book_id}/marks', headers=auth_headers, json={
        'reader_type': 'epub', 'kind': 'note', 'label': 'My annotation', 'note': 'Keep every word of this note.',
        'chapter_index': 1, 'progress_percent': 35,
    }).json()
    replaced = client.post(f'/api/v1/uploads/books/{book_id}/replace', headers=auth_headers,
                           files={'file': ('new.epub', BytesIO(make_minimal_epub_bytes(chapter_text='New text')), 'application/epub+zip')},
                           data={'keep_progress': str(keep_progress).lower()})
    assert replaced.status_code == 200
    assert client.get(f"/api/v1/uploads/tasks/{replaced.json()['task_id']}", headers=auth_headers).json()['status'] == 'ready'
    marks = client.get(f'/api/v1/books/{book_id}/marks', headers=auth_headers).json()
    assert len(marks) == 1
    assert {key: marks[0][key] for key in ['id', 'note', 'label', 'created_at']} == {key: original[key] for key in ['id', 'note', 'label', 'created_at']}
    assert marks[0]['position_valid'] is False


def create_note(client, headers, book_id='b1', **extra):
    response = client.post(f'/api/v1/books/{book_id}/marks', headers=headers, json={
        'kind': 'note', 'note': '原始备注\n第二行不能丢失。', 'label': '手动标题',
        'reader_type': 'epub', 'chapter_index': 2, 'progress_percent': 20, **extra,
    })
    assert response.status_code == 201, response.text
    return response.json()


def retire(client, mark_id):
    with client.app.state.db_session_factory() as session:
        session.execute(update(ReaderMarkRecord).where(ReaderMarkRecord.id == mark_id).values(position_valid=False))
        session.commit()


@pytest.mark.parametrize('reader_type', ['epub', 'text', 'pdf', 'comic', 'image'])
def test_relocation_changes_only_position_and_keeps_identity(client, auth_headers, reader_type):
    original = create_note(client, auth_headers, epub_cfi='aisu-scroll:0.7')
    retire(client, original['id'])
    if reader_type in {'pdf', 'comic', 'image'}:
        seed_pages(client, reader_type)
        target = payload_for(resource(client, auth_headers))
    else:
        chapters = seed_chapters(client)
        if reader_type == 'text':
            with client.app.state.db_session_factory() as session:
                books = SqlAlchemyBookRepository(session)
                books.save(books.get_by_id('b1').with_changes(reader_type='text'))
        target = {'reader_type': reader_type, 'chapter_index': 3, 'position_key': chapters[2].id,
                  'epub_cfi': 'aisu-scroll:0.3', 'progress_percent': 77}
    response = client.put(f"/api/v1/books/b1/marks/{original['id']}/position", headers=auth_headers,
                          json={**target, 'note': '不允许通过定位接口覆盖正文', 'label': '不能改标题'})
    assert response.status_code == 200, response.text
    moved = response.json()
    for field in ['id', 'book_id', 'kind', 'note', 'label', 'created_at']:
        assert moved[field] == original[field]
    assert moved['position_valid'] is True
    for field in ['reader_type', 'position_key', 'chapter_index', 'image_index', 'page_number', 'epub_cfi']:
        assert moved[field] == target.get(field)
    assert moved['progress_percent'] == (67 if reader_type in {'comic', 'image'} else target['progress_percent'])
    with client.app.state.db_session_factory() as session:
        stored = session.get(ReaderMarkRecord, original['id'])
        assert stored.progress_percent == target['progress_percent']
    assert moved['updated_at'] > original['updated_at']
    assert client.get('/api/v1/books/b1/marks', headers=auth_headers).json() == [moved]


@pytest.mark.parametrize('invalid', ['missing_key', 'old_key', 'bad_index', 'mixed_coordinates', 'wrong_format'])
def test_failed_relocation_does_not_modify_original_mark(client, auth_headers, invalid):
    original = create_note(client, auth_headers)
    retire(client, original['id'])
    before = client.get('/api/v1/books/b1/marks', headers=auth_headers).json()
    chapters = seed_chapters(client)
    target = {'reader_type': 'epub', 'position_key': chapters[1].id, 'chapter_index': 2, 'progress_percent': 40}
    if invalid == 'missing_key': target.pop('position_key')
    elif invalid == 'old_key': target['position_key'] = 'old-chapter'
    elif invalid == 'bad_index': target['chapter_index'] = 1
    elif invalid == 'mixed_coordinates': target['page_number'] = 1
    else: target['reader_type'] = 'comic'
    response = client.put(f"/api/v1/books/b1/marks/{original['id']}/position", headers=auth_headers, json=target)
    assert response.status_code == (422 if invalid == 'missing_key' else 409)
    assert client.get('/api/v1/books/b1/marks', headers=auth_headers).json() == before


@pytest.mark.parametrize('operation', ['edit', 'delete', 'relocate', 'legacy_create'])
def test_publication_between_mark_read_and_write_cannot_restore_stale_position(client, auth_headers, monkeypatch, operation):
    chapters = seed_chapters(client)
    original_note = create_note(client, auth_headers, position_key=chapters[1].id)
    original_lock = SqlAlchemyBookRepository.lock_revision
    changed = False
    def publish_before_lock(repository, book):
        nonlocal changed
        if not changed:
            changed = True
            change_chapters(client, chapters, 'replace')
            retire(client, original_note['id'])
        return original_lock(repository, book)
    monkeypatch.setattr(SqlAlchemyBookRepository, 'lock_revision', publish_before_lock)
    url = f"/api/v1/books/b1/marks/{original_note['id']}"
    if operation == 'edit': result = client.patch(url, headers=auth_headers, json={'note': '不应覆盖'})
    elif operation == 'delete': result = client.delete(url, headers=auth_headers)
    elif operation == 'legacy_create': result = client.post('/api/v1/books/b1/marks', headers=auth_headers, json={'reader_type': 'epub', 'kind': 'note', 'chapter_index': 1, 'progress_percent': 20})
    else: result = client.put(url+'/position', headers=auth_headers, json={'reader_type': 'epub', 'position_key': chapters[1].id, 'chapter_index': 2, 'progress_percent': 20})
    assert changed and result.status_code == 409
    marks = client.get('/api/v1/books/b1/marks', headers=auth_headers).json()
    assert len(marks) == 1 and marks[0]['id'] == original_note['id']
    assert marks[0]['note'] == original_note['note'] and marks[0]['position_valid'] is False


def test_mark_edit_reloads_position_after_book_lock(client, auth_headers, monkeypatch):
    original = create_note(client, auth_headers)
    original_lock = SqlAlchemyBookRepository.lock_revision
    def invalidate_after_snapshot(repository, book):
        original_lock(repository, book)
        repository._session.execute(update(ReaderMarkRecord).where(ReaderMarkRecord.id == original['id']).values(position_valid=False))
    monkeypatch.setattr(SqlAlchemyBookRepository, 'lock_revision', invalidate_after_snapshot)
    edited = client.patch(f"/api/v1/books/b1/marks/{original['id']}", headers=auth_headers, json={'note': '修改后的内容'})
    assert edited.status_code == 200
    assert edited.json()['note'] == '修改后的内容'
    assert edited.json()['position_valid'] is False


def test_relocation_works_even_if_previous_mark_timestamp_is_in_the_future(client, auth_headers):
    from datetime import datetime, timedelta, timezone
    original = create_note(client, auth_headers)
    future = datetime.now(timezone.utc) + timedelta(days=30)
    with client.app.state.db_session_factory() as session:
        session.execute(update(ReaderMarkRecord).where(ReaderMarkRecord.id == original['id']).values(updated_at=future, position_valid=False))
        session.commit()
    chapters = seed_chapters(client)
    moved = client.put(f"/api/v1/books/b1/marks/{original['id']}/position", headers=auth_headers,
        json={'reader_type': 'epub', 'position_key': chapters[0].id, 'chapter_index': 1, 'progress_percent': 2})
    assert moved.status_code == 200
    assert moved.json()['position_valid'] is True
    assert datetime.fromisoformat(moved.json()['updated_at']) > future


def test_deleted_chapter_notes_survive_without_shifting_already_invalid_positions(client, auth_headers):
    uploaded = client.post('/api/v1/uploads/books', headers=auth_headers, files={'file': ('book.epub',
        make_minimal_epub_bytes(chapter_texts=['第一话正文。', '第二话正文。', '第三话正文。']), 'application/epub+zip')})
    book_id = uploaded.json()['book_id']
    deleted = create_note(client, auth_headers, book_id, chapter_index=2)
    shifted = create_note(client, auth_headers, book_id, chapter_index=3)
    old = create_note(client, auth_headers, book_id, chapter_index=3)
    retire(client, old['id'])
    assert client.delete(f'/api/v1/books/{book_id}/chapters/2', headers=auth_headers).status_code == 200
    marks = {mark['id']: mark for mark in client.get(f'/api/v1/books/{book_id}/marks', headers=auth_headers).json()}
    assert len(marks) == 3
    assert marks[deleted['id']]['position_valid'] is False
    assert marks[shifted['id']]['chapter_index'] == 2 and marks[shifted['id']]['position_valid'] is True
    assert marks[old['id']]['chapter_index'] == 3 and marks[old['id']]['position_valid'] is False
    for original in [deleted, shifted, old]:
        assert all(marks[original['id']][key] == original[key] for key in ['note', 'label', 'created_at'])


def test_reprocess_retains_notes_and_retires_regenerated_chapter_positions(client, auth_headers):
    uploaded = client.post('/api/v1/uploads/books', headers=auth_headers, files={'file': ('book.epub',
        make_minimal_epub_bytes(chapter_texts=['第一话正文。', '第二话正文。']), 'application/epub+zip')})
    book_id = uploaded.json()['book_id']
    key = client.get(f'/api/v1/books/{book_id}/reader', headers=auth_headers).json()['toc'][1]['position_key']
    original = create_note(client, auth_headers, book_id, position_key=key)
    result = client.post(f'/api/v1/uploads/books/{book_id}/reprocess', headers=auth_headers)
    assert result.status_code == 200
    marks = client.get(f'/api/v1/books/{book_id}/marks', headers=auth_headers).json()
    assert len(marks) == 1
    assert all(marks[0][field] == original[field] for field in ['id', 'note', 'label', 'created_at', 'position_key'])
    new_key = client.get(f'/api/v1/books/{book_id}/reader', headers=auth_headers).json()['toc'][1]['position_key']
    assert marks[0]['position_valid'] is (new_key == key)


def test_failed_publication_rolls_back_position_retirement_with_the_file(client, auth_headers, monkeypatch):
    uploaded = client.post('/api/v1/uploads/books', headers=auth_headers, files={'file': ('old.epub',
        make_minimal_epub_bytes(chapter_text='保留的旧正文。'), 'application/epub+zip')})
    book_id = uploaded.json()['book_id']
    original = create_note(client, auth_headers, book_id, chapter_index=1)
    original_file = client.get(f'/api/v1/files/books/{book_id}/original', headers=auth_headers).content
    with client.app.state.db_session_factory() as session:
        old_path = SqlAlchemyBookRepository(session).get_by_id(book_id).original_file_path
    save = SqlAlchemyBookRepository.save
    reached = False
    def fail_final_publish(repository, book):
        nonlocal reached
        if book.id == book_id and book.original_file_path != old_path and book.status == 'ready':
            reached = True
            raise RuntimeError('模拟书籍发布事务失败')
        return save(repository, book)
    monkeypatch.setattr(SqlAlchemyBookRepository, 'save', fail_final_publish)
    result = client.post(f'/api/v1/uploads/books/{book_id}/replace', headers=auth_headers, files={'file': ('new.epub',
        make_minimal_epub_bytes(chapter_text='不会发布的新正文。'), 'application/epub+zip')})
    assert result.status_code == 200
    assert client.get(f"/api/v1/uploads/tasks/{result.json()['task_id']}", headers=auth_headers).json()['status'] == 'failed'
    assert reached
    assert client.get(f'/api/v1/books/{book_id}/marks', headers=auth_headers).json() == [original]
    assert client.get(f'/api/v1/files/books/{book_id}/original', headers=auth_headers).content == original_file


def test_reader_can_only_relocate_own_note_and_can_edit_it_after_book_becomes_private(client, auth_headers):
    uploaded = client.post('/api/v1/uploads/books', headers=auth_headers, files={'file': ('shared.epub',
        make_minimal_epub_bytes(chapter_texts=['第一话正文。', '第二话正文。']), 'application/epub+zip')})
    book_id = uploaded.json()['book_id']
    invitation = client.post('/api/v1/invitations/me', headers=auth_headers).json()['code']
    registered = client.post('/api/v1/auth/register', json={'email': 'retained-reader@example.com', 'nickname': '读者', 'password': 'reader-password', 'invitation_code': invitation})
    assert registered.status_code == 200
    reader_headers = {'Authorization': f"Bearer {registered.json()['access_token']}"}
    assert client.post(f'/api/v1/books/{book_id}/share-request', headers=auth_headers).status_code == 200
    assert client.post(f'/api/v1/books/{book_id}/share-request/approve', headers=auth_headers).status_code == 200
    owner_note = create_note(client, auth_headers, book_id)
    reader_note = create_note(client, reader_headers, book_id)
    key = client.get(f'/api/v1/books/{book_id}/reader', headers=auth_headers).json()['toc'][0]['position_key']
    target = {'reader_type': 'epub', 'position_key': key, 'chapter_index': 1, 'progress_percent': 5}
    assert client.put(f"/api/v1/books/{book_id}/marks/{owner_note['id']}/position", headers=reader_headers, json=target).status_code == 404
    assert client.put(f"/api/v1/books/{book_id}/marks/{reader_note['id']}/position", headers=auth_headers, json=target).status_code == 404
    assert client.put(f"/api/v1/books/{book_id}/marks/{reader_note['id']}/position", headers=reader_headers, json=target).status_code == 200
    with client.app.state.db_session_factory() as session:
        books = SqlAlchemyBookRepository(session)
        books.save(books.get_by_id(book_id).with_changes(public_status='private'))
    assert client.put(f"/api/v1/books/{book_id}/marks/{reader_note['id']}/position", headers=reader_headers, json=target).status_code == 404
    edited = client.patch(f"/api/v1/books/{book_id}/marks/{reader_note['id']}", headers=reader_headers, json={'note': '读者自己的备注仍可修改'})
    assert edited.status_code == 200 and edited.json()['note'] == '读者自己的备注仍可修改'
    assert client.delete(f"/api/v1/books/{book_id}/marks/{reader_note['id']}", headers=reader_headers).status_code == 204
    assert client.get(f'/api/v1/books/{book_id}/marks', headers=auth_headers).json() == [owner_note]


def test_reprocess_only_keeps_positions_bound_to_surviving_matching_format(client, auth_headers):
    chapters = seed_chapters(client)
    current = create_note(client, auth_headers, position_key=chapters[1].id)
    legacy = create_note(client, auth_headers)
    removed = create_note(client, auth_headers, position_key=chapters[2].id, chapter_index=3)
    with client.app.state.db_session_factory() as session:
        retire_reader_mark_positions(session=session, book_id='b1', valid_keys={chapters[1].id}, reader_type='epub')
        session.commit()
    marks = {mark['id']: mark for mark in client.get('/api/v1/books/b1/marks', headers=auth_headers).json()}
    assert marks[current['id']] == current
    assert marks[legacy['id']]['position_valid'] is False
    assert marks[removed['id']]['position_valid'] is False
    with client.app.state.db_session_factory() as session:
        retire_reader_mark_positions(session=session, book_id='b1', valid_keys={chapters[1].id}, reader_type='text')
        session.commit()
    assert all(mark['position_valid'] is False for mark in client.get('/api/v1/books/b1/marks', headers=auth_headers).json())
