from dataclasses import replace
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.core.config import Settings
from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.reader_marks.repository import SqlAlchemyReaderMarkRepository
from app.modules.users.models import UserRecord
from test_chapter_mutation_receipts import make_book


def resource(client, headers, bid):
    return client.get(f'/api/v1/books/{bid}/reader', headers=headers).json()


def note(client, headers, bid, index=2, **extra):
    current = resource(client, headers, bid)['toc'][index - 1]
    response = client.post(f'/api/v1/books/{bid}/marks', headers=headers, json={
        'reader_type': resource(client, headers, bid)['reader_type'], 'kind': 'note', 'note': '原备注第一行。\n第二行。',
        'label': '手动旁注', 'progress_percent': 45, 'chapter_index': index, 'epub_cfi': 'aisu-scroll:0.45',
        'position_key': current['position_key'], 'content_version': current['content_version'], **extra})
    assert response.status_code == 201, response.text
    return response.json()


def raw(client, bid):
    with client.app.state.db_session_factory() as session:
        return {mark.id: mark for mark in SqlAlchemyReaderMarkRepository(session).list_all_for_book(bid)}


@pytest.mark.parametrize('ext', ['epub', 'txt'])
def test_body_edit_retires_only_positions_in_that_chapter_and_preserves_every_readers_note(client, auth_headers, ext):
    bid = make_book(client, auth_headers, ext)
    keyed = note(client, auth_headers, bid)
    legacy = note(client, auth_headers, bid, position_key=None, content_version=None)
    elsewhere = note(client, auth_headers, bid, index=3)
    retired = note(client, auth_headers, bid)
    old_format = note(client, auth_headers, bid)
    with client.app.state.db_session_factory() as session:
        repo = SqlAlchemyReaderMarkRepository(session)
        repo.rebase_position(repo.get(Settings.default_user_id, retired['id']), replace(repo.get(Settings.default_user_id, retired['id']), position_valid=False))
        value = repo.get(Settings.default_user_id, old_format['id'])
        repo.save(value.with_changes(reader_type='pdf'))
        now = datetime.now(timezone.utc)
        session.add(UserRecord(id='chapter-note-reader', account_number=986751, email='chapter-note@example.local', nickname='读者',
                               password_hash='test-only', role='user', status='active', created_at=now, updated_at=now))
        session.commit()
        other = replace(repo.get(Settings.default_user_id, keyed['id']), id=str(uuid4()), user_id='chapter-note-reader')
        repo.save(other)
    before = raw(client, bid)
    response = client.put(f'/api/v1/books/{bid}/chapters/2', headers=auth_headers, json={'title': '第2章 修订', 'content': '补充的前文。\n\n原句被移到后面。'})
    assert response.status_code == 200, response.text
    after = raw(client, bid)
    affected = {keyed['id'], legacy['id'], other.id}
    assert after == {mid: replace(mark, position_valid=False) if mid in affected else mark for mid, mark in before.items()}
    assert resource(client, auth_headers, bid)['toc'][1]['position_key'] == keyed['position_key']
    public = {item['id']: item for item in client.get(f'/api/v1/books/{bid}/marks', headers=auth_headers).json()}
    assert public[keyed['id']]['position_valid'] is False and public[elsewhere['id']]['position_valid'] is True
    assert public[keyed['id']]['content_version'] is None
    assert public[elsewhere['id']]['content_version'] == resource(client, auth_headers, bid)['toc'][2]['content_version']


@pytest.mark.parametrize('ext', ['epub', 'txt'])
def test_title_only_and_append_keep_existing_positions_usable(client, auth_headers, ext):
    bid = make_book(client, auth_headers, ext)
    original = note(client, auth_headers, bid)
    before = raw(client, bid)
    chapter = client.get(f'/api/v1/books/{bid}/reader/chapters/2', headers=auth_headers).json()
    response = client.put(f'/api/v1/books/{bid}/chapters/2', headers=auth_headers, json={'title': '只修改话名', 'content': chapter['content']})
    assert response.status_code == 200, response.text
    assert raw(client, bid) == before
    current = client.get(f'/api/v1/books/{bid}/marks', headers=auth_headers).json()[0]
    assert current['position_valid'] is True
    assert current['content_version'] != original.get('content_version')
    assert client.post(f'/api/v1/books/{bid}/chapters', headers=auth_headers, json={'title': '追加', 'content': '后续正文。'}).status_code == 200
    assert raw(client, bid) == before


@pytest.mark.parametrize('operation', ['create', 'relocate'])
@pytest.mark.parametrize('keyed', [True, False])
def test_old_content_version_cannot_bind_a_note_to_revised_prose(client, auth_headers, operation, keyed):
    bid = make_book(client, auth_headers)
    original = note(client, auth_headers, bid)
    old = resource(client, auth_headers, bid)['toc'][1]
    assert original.get('content_version') == old['content_version']
    assert client.put(f'/api/v1/books/{bid}/chapters/2', headers=auth_headers, json={'content': '修改后的第二话。'}).status_code == 200
    before = raw(client, bid)
    payload = {'reader_type': 'text', 'chapter_index': 2, 'epub_cfi': 'aisu-scroll:0.2', 'progress_percent': 50, 'content_version': old['content_version']}
    if keyed or operation == 'relocate':
        payload['position_key'] = old['position_key']
    response = client.post(f'/api/v1/books/{bid}/marks', headers=auth_headers, json=payload) if operation == 'create' else client.put(
        f"/api/v1/books/{bid}/marks/{original['id']}/position", headers=auth_headers, json=payload)
    assert response.status_code == 409, response.text
    assert raw(client, bid) == before
    if operation == 'relocate':
        payload['content_version'] = resource(client, auth_headers, bid)['toc'][1]['content_version']
        restored = client.put(f"/api/v1/books/{bid}/marks/{original['id']}/position", headers=auth_headers, json=payload)
        assert restored.status_code == 200, restored.text
        assert restored.json()['position_valid'] is True
        assert all(restored.json()[field] == original[field] for field in ['id', 'note', 'label', 'created_at'])


def test_failed_chapter_publication_rolls_back_retirement_and_retry_does_not_retire_a_relocated_note(client, auth_headers, monkeypatch):
    bid = make_book(client, auth_headers)
    original = note(client, auth_headers, bid)
    before = raw(client, bid)
    with client.app.state.db_session_factory() as session:
        old_path = SqlAlchemyBookRepository(session).get_by_id(bid).original_file_path
    save = SqlAlchemyBookRepository.save
    def fail(repository, book):
        if book.id == bid and book.original_file_path != old_path:
            raise RuntimeError('模拟发布失败')
        return save(repository, book)
    with monkeypatch.context() as patch:
        patch.setattr(SqlAlchemyBookRepository, 'save', fail)
        with pytest.raises(RuntimeError, match='模拟发布失败'):
            client.put(f'/api/v1/books/{bid}/chapters/2', headers=auth_headers, json={'content': '这次修订应回滚。'})
    assert raw(client, bid) == before
    request_headers = {**auth_headers, 'Idempotency-Key': str(uuid4())}
    payload = {'content': '第二次修订正文。'}
    assert client.put(f'/api/v1/books/{bid}/chapters/2', headers=request_headers, json=payload).status_code == 200
    current = resource(client, auth_headers, bid)['toc'][1]
    relocated = client.put(f"/api/v1/books/{bid}/marks/{original['id']}/position", headers=auth_headers, json={
        'reader_type': 'text', 'position_key': current['position_key'], 'content_version': current['content_version'],
        'chapter_index': 2, 'epub_cfi': 'aisu-scroll:0.7', 'progress_percent': 60})
    assert relocated.status_code == 200 and relocated.json()['position_valid'] is True
    moved = raw(client, bid)
    assert client.put(f'/api/v1/books/{bid}/chapters/2', headers=request_headers, json=payload).status_code == 200
    assert raw(client, bid) == moved
