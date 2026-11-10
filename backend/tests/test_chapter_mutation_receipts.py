from uuid import uuid4
from io import BytesIO
from zipfile import ZipFile

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.modules.auth.models import ApiRequestRecord


def make_book(client: TestClient, headers: dict[str, str], file_ext='txt') -> str:
    text = '第1章 开始\n\n正文一。\n\n第2章 继续\n\n正文二。\n\n第3章 结束\n\n正文三。'.encode()
    if file_ext == 'epub':
        from test_reader import make_epub_with_documents
        text = make_epub_with_documents([('第1章 开始', '正文一。'), ('第2章 继续', '正文二。'), ('第3章 结束', '正文三。')])
    response = client.post('/api/v1/uploads/books', headers=headers, files={
        'file': ('retry.' + file_ext, text, 'application/epub+zip' if file_ext == 'epub' else 'text/plain'),
    })
    assert response.status_code == 200
    return response.json()['book_id']


def edit_headers(client, headers, book_id, index=2):
    chapter = client.get(f'/api/v1/books/{book_id}/chapters/{index}/edit', headers=headers)
    assert chapter.status_code == 200
    return {**headers, 'Idempotency-Key': str(uuid4()), 'If-Match': f'"{chapter.json()["revision"]}"'}


def original_text(client, headers, book_id):
    response = client.get(f'/api/v1/files/books/{book_id}/original', headers=headers)
    assert response.status_code == 200
    if response.content.startswith(b'PK'):
        with ZipFile(BytesIO(response.content)) as archive:
            return '\n'.join(archive.read(name).decode() for name in archive.namelist() if name.endswith('.xhtml'))
    return response.content.decode()


def test_delete_retry_replays_receipt_without_deleting_the_next_chapter(client, auth_headers):
    book_id = make_book(client, auth_headers)
    headers = {**auth_headers, 'Idempotency-Key': str(uuid4())}
    first = client.delete(f'/api/v1/books/{book_id}/chapters/2', headers=headers)
    retried = client.delete(f'/api/v1/books/{book_id}/chapters/2', headers=headers)
    assert first.status_code == retried.status_code == 200
    assert first.json() == retried.json()
    text = original_text(client, auth_headers, book_id)
    assert '正文二。' not in text and '正文三。' in text


def test_new_delete_with_a_stale_revision_preserves_the_next_chapter(client, auth_headers):
    book_id = make_book(client, auth_headers)
    headers = edit_headers(client, auth_headers, book_id)
    assert client.delete(f'/api/v1/books/{book_id}/chapters/2', headers=headers).status_code == 200
    stale = {**headers, 'Idempotency-Key': str(uuid4())}
    assert client.delete(f'/api/v1/books/{book_id}/chapters/2', headers=stale).status_code == 412
    assert '正文三。' in original_text(client, auth_headers, book_id)


def test_update_replays_its_receipt_and_rejects_another_stale_write(client, auth_headers):
    book_id = make_book(client, auth_headers)
    headers = edit_headers(client, auth_headers, book_id)
    payload = {'title': '第2章 修改', 'content': '编辑过的正文。'}
    saved = client.put(f'/api/v1/books/{book_id}/chapters/2', headers=headers, json=payload)
    retried = client.put(f'/api/v1/books/{book_id}/chapters/2', headers=headers, json=payload)
    assert saved.status_code == retried.status_code == 200
    assert saved.json() == retried.json()
    stale = client.put(f'/api/v1/books/{book_id}/chapters/2', headers={**headers, 'Idempotency-Key': str(uuid4())},
                       json={**payload, 'content': '旧窗口的新草稿。'})
    assert stale.status_code == 412
    assert '编辑过的正文。' in original_text(client, auth_headers, book_id)
    assert '旧窗口的新草稿。' not in original_text(client, auth_headers, book_id)


def test_append_replays_its_receipt_and_rejects_reused_identity_for_other_content(client, auth_headers):
    book_id = make_book(client, auth_headers)
    headers = {**auth_headers, 'Idempotency-Key': str(uuid4())}
    payload = {'title': '第4章 归途', 'content': '追加的正文。', 'content_is_body': True}
    first = client.post(f'/api/v1/books/{book_id}/chapters', headers=headers, json=payload)
    retried = client.post(f'/api/v1/books/{book_id}/chapters', headers=headers, json=payload)
    assert first.status_code == retried.status_code == 200
    assert first.json() == retried.json()
    assert first.json()['chapter_count'] == 4
    conflict = client.post(f'/api/v1/books/{book_id}/chapters', headers=headers,
                          json={**payload, 'content': '另一段正文。'})
    assert conflict.status_code == 409
    resource = client.get(f'/api/v1/books/{book_id}/reader', headers=auth_headers)
    assert resource.json()['chapter_count'] == 4


def mutate(client, headers, book_id, operation):
    path = f'/api/v1/books/{book_id}/chapters'
    if operation == 'append':
        return client.post(path, headers=headers, json={'title': '第4章 后续', 'content': '追加正文。'})
    if operation == 'update':
        return client.put(path + '/2', headers=headers, json={'title': '第2章 修订', 'content': '修订正文。'})
    return client.delete(path + '/2', headers=headers)


@pytest.mark.parametrize('operation', ['append', 'update', 'delete'])
@pytest.mark.parametrize('committed', [False, True])
def test_commit_failure_is_reconciled_before_any_file_rollback(client, auth_headers, monkeypatch, operation, committed):
    book_id = make_book(client, auth_headers)
    headers = edit_headers(client, auth_headers, book_id)
    if operation == 'append':
        headers.pop('If-Match')
    original = original_text(client, auth_headers, book_id)
    native_commit = Session.commit
    raised = False

    def fail_once(session):
        nonlocal raised
        chapter_write = not raised and any(isinstance(record, ApiRequestRecord) for record in session.new)
        if chapter_write:
            raised = True
            if committed:
                native_commit(session)
            raise RuntimeError('simulated commit acknowledgement failure')
        return native_commit(session)

    monkeypatch.setattr(Session, 'commit', fail_once)
    if committed:
        response = mutate(client, headers, book_id, operation)
        assert response.status_code == 200
    else:
        with pytest.raises(RuntimeError, match='commit acknowledgement'):
            mutate(client, headers, book_id, operation)
        assert original_text(client, auth_headers, book_id) == original
        assert client.get(f'/api/v1/books/{book_id}/reader', headers=auth_headers).json()['chapter_count'] == 3
    retry = mutate(client, headers, book_id, operation)
    assert retry.status_code == 200
    resource = client.get(f'/api/v1/books/{book_id}/reader', headers=auth_headers).json()
    assert resource['chapter_count'] == {'append': 4, 'update': 3, 'delete': 2}[operation]
    text = original_text(client, auth_headers, book_id)
    assert '正文三。' in text
    if operation == 'update':
        assert '修订正文。' in text
    elif operation == 'delete':
        assert '正文二。' not in text


@pytest.mark.parametrize('operation', ['append', 'update', 'delete'])
@pytest.mark.parametrize('committed', [False, True])
@pytest.mark.parametrize('file_ext', ['txt', 'epub'])
def test_unverifiable_commit_keeps_files_and_a_later_retry_recovers_its_receipt(client, auth_headers, monkeypatch, operation, committed, file_ext):
    from app.modules.books import chapter_mutations
    from pathlib import Path

    book_id = make_book(client, auth_headers, file_ext)
    headers = edit_headers(client, auth_headers, book_id)
    if operation == 'append':
        headers.pop('If-Match')
    native_commit, native_read = Session.commit, chapter_mutations.read_receipt
    uncertain = False
    failed = False
    original = original_text(client, auth_headers, book_id)
    root = Path(client.app.state.settings.storage_root)
    original_files = {path: path.read_bytes() for path in root.rglob('*') if path.is_file()}

    def fail_after_commit(session):
        nonlocal uncertain, failed
        chapter_write = not failed and any(isinstance(record, ApiRequestRecord) for record in session.new)
        if chapter_write:
            failed = True
            if committed:
                native_commit(session)
            uncertain = True
            raise RuntimeError('lost commit response')
        native_commit(session)

    def unavailable_receipt(*args, **kwargs):
        if uncertain:
            raise RuntimeError('database temporarily unreachable')
        return native_read(*args, **kwargs)

    monkeypatch.setattr(Session, 'commit', fail_after_commit)
    monkeypatch.setattr(chapter_mutations, 'read_receipt', unavailable_receipt)
    assert mutate(client, headers, book_id, operation).status_code == 503
    # Either database outcome must leave every preexisting file untouched.
    # Readers follow complete database versions, never a half-written book.
    assert all(path.is_file() and path.read_bytes() == data for path, data in original_files.items())
    resource = client.get(f'/api/v1/books/{book_id}/reader', headers=auth_headers).json()
    assert resource['chapter_count'] == ({'append': 4, 'update': 3, 'delete': 2}[operation] if committed else 3)
    current_original = original_text(client, auth_headers, book_id)
    if not committed:
        assert current_original == original
        chapter = client.get(f'/api/v1/books/{book_id}/reader/chapters/2', headers=auth_headers)
        assert chapter.status_code == 200 and '正文二。' in chapter.json()['content']
    elif operation == 'update':
        assert '修订正文。' in current_original
    elif operation == 'delete':
        assert '正文二。' not in current_original and '正文三。' in current_original
    uncertain = False
    assert mutate(client, headers, book_id, operation).status_code == 200
    resource = client.get(f'/api/v1/books/{book_id}/reader', headers=auth_headers).json()
    assert resource['chapter_count'] == {'append': 4, 'update': 3, 'delete': 2}[operation]
    assert '正文三。' in original_text(client, auth_headers, book_id)
    if operation == 'update':
        assert '修订正文。' in original_text(client, auth_headers, book_id)


@pytest.mark.parametrize('revision', ['*', 'W/"' + 'a' * 64 + '"', 'invalid', '"' + 'a' * 64])
def test_invalid_precondition_cannot_execute_a_delete(client, auth_headers, revision):
    book_id = make_book(client, auth_headers)
    response = client.delete(f'/api/v1/books/{book_id}/chapters/2', headers={**auth_headers, 'If-Match': revision})
    assert response.status_code == 422
    assert '正文二。' in original_text(client, auth_headers, book_id)
