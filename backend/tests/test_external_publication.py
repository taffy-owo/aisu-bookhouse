from datetime import datetime, timezone
import json
from pathlib import Path
from uuid import uuid4
import pytest

from app.modules.books.models import BookRecord
from app.modules.translations.epub import append_translation_epub
from app.modules.translations.models import WholeBookTranslationJobRecord as Job
from app.modules.translation_v2.runner import snapshot
from test_uploads import make_minimal_epub_bytes


SOURCE = 'https://kakuyomu.jp/works/1234567890'


def test_publication_check_ignores_binary_cover_assets(client, auth_headers):
    from test_uploads import TINY_PNG_BYTES
    response = client.post('/api/v1/uploads/books', headers=auth_headers,
        files={'file': ('illustrated.epub', make_minimal_epub_bytes(
            chapter_text='插画书籍的正文。', cover_bytes=TINY_PNG_BYTES), 'application/epub+zip')})
    assert response.status_code == 200, response.text
    result = check(client, auth_headers, response.json()['book_id'])
    assert result['in_sync'], result
    assert result['original_chapter_count'] == result['reader_chapter_count'] == 1


def test_append_filename_is_not_proof_of_source_chapter_identity(client, auth_headers):
    bid=upload(client,auth_headers)
    with client.app.state.db_session_factory() as session:
        book=session.get(BookRecord,bid)
        original=Path(client.app.state.settings.storage_root,book.original_file_path)
        original.write_bytes(append_translation_epub(original_epub=original.read_bytes(),chapters=[{
            'index':2,'title':'用户备注','paragraphs':['这是一份手工备注，并非原作第二话。']}]))
    assert client.post(f'/api/v1/uploads/books/{bid}/reprocess',headers=auth_headers).status_code==200
    verified=check(client,auth_headers,bid)
    assert verified['in_sync'] and verified['chapters'][1]['source_index'] is None
    jid=make_job(client,bid,indexes=(2,))
    response=client.post(f'/api/v1/translations/{jid}/reconcile',headers=auth_headers,
        json=request(client,auth_headers,bid,jid))
    assert response.status_code==409,response.text
    assert response.json()['detail']['error_code']=='publication_coverage_unproven'


def upload(client, headers, chapters=('正文一。',)):
    result = client.post('/api/v1/uploads/books', headers=headers, data={'source_url': SOURCE},
        files={'file': ('test.epub', make_minimal_epub_bytes(chapter_texts=list(chapters)), 'application/epub+zip')})
    assert result.status_code == 200, result.text
    return result.json()['book_id']


def make_job(client, book_id, *, indexes=(1,), status='failed'):
    job_id = str(uuid4())
    with client.app.state.db_session_factory() as session:
        book = session.get(BookRecord, book_id)
        episodes = [{'index': i, 'title': f'第{i}話', 'url': f'{SOURCE}/episodes/{i}'} for i in indexes]
        session.add(Job(id=job_id, user_id=book.owner_id, book_id=book_id, job_kind='source_update',
            source_url=SOURCE, source_provider='kakuyomu', title='测试译本', author='作者', status=status,
            stage=status, progress=0, total_chapters=len(episodes), completed_chapters=0,
            model='literary-model', provider_base_url='https://example.org/v1', provider_api_key_encrypted='SECRET',
            catalog_json=episodes, metadata_json={'episodes': episodes},
            quality_report_json={'_workflow_version': 2}, created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc)))
        session.commit()
    return job_id


def check(client, headers, book_id):
    result = client.get(f'/api/v1/books/{book_id}/publication-check', headers=headers)
    assert result.status_code == 200, result.text
    return result.json()


def request(client, headers, book_id, job_id):
    job = client.get(f'/api/v1/translations/{job_id}', headers=headers).json()
    return {'request_id': str(uuid4()), 'book_id': book_id,
        'expected_book_revision': check(client, headers, book_id)['revision'],
        'expected_job_updated_at': job['updated_at']}


def test_detects_direct_epub_append_and_reprocess_repairs_online_catalog(client, auth_headers):
    bid = upload(client, auth_headers)
    other_bid = upload(client, auth_headers)
    assert check(client, auth_headers, bid)['in_sync']
    with client.app.state.db_session_factory() as session:
        book = session.get(BookRecord, bid)
        book.source_pending_episode_indexes, book.source_update_count = [2, 3], 2
        other = session.get(BookRecord, other_bid)
        other.source_pending_episode_indexes, other.source_update_count = [2, 3], 2
        session.commit()
        original = Path(client.app.state.settings.storage_root, book.original_file_path)
        original.write_bytes(append_translation_epub(original_epub=original.read_bytes(), chapters=[{
            'index': 2, 'title': '第2话 新章', 'paragraphs': ['新的正文。'], 'source_url': SOURCE + '/episodes/2'}]))
    stale = check(client, auth_headers, bid)
    assert not stale['in_sync']
    assert (stale['original_chapter_count'], stale['reader_chapter_count']) == (2, 1)
    jid = make_job(client, bid, indexes=(2,))
    result = client.post(f'/api/v1/translations/{jid}/reconcile', headers=auth_headers,
        json=request(client, auth_headers, bid, jid))
    assert result.status_code == 409 and result.json()['detail']['error_code'] == 'publication_out_of_sync'
    assert client.post(f'/api/v1/uploads/books/{bid}/reprocess', headers=auth_headers).status_code == 200
    assert check(client, auth_headers, bid)['in_sync']
    body = request(client, auth_headers, bid, jid)
    result = client.post(f'/api/v1/translations/{jid}/reconcile', headers=auth_headers, json=body)
    assert result.status_code == 200, result.text
    assert result.json()['evidence'][0]['method'] == 'source_url'
    assert client.post(f'/api/v1/translations/{jid}/reconcile', headers=auth_headers, json=body).json() == result.json()
    body['acknowledge'] = True
    assert client.post(f'/api/v1/translations/{jid}/reconcile', headers=auth_headers, json=body).status_code == 409
    state = client.get(f'/api/v1/translations/{jid}', headers=auth_headers).json()
    assert state['status'] == 'ready' and state['stage'] == 'external_completed'
    assert state['quality_status'] == 'pending' and state['error_message'] is None
    with client.app.state.db_session_factory() as session:
        assert session.get(BookRecord, bid).source_pending_episode_indexes == [3]
        assert session.get(BookRecord, bid).source_update_count == 1
        assert session.get(BookRecord, other_bid).source_pending_episode_indexes == [2, 3]


def test_same_count_changed_content_and_missing_reader_file_are_not_in_sync(client, auth_headers):
    from app.modules.book_assets.models import BookAssetRecord
    from sqlalchemy import select
    bid = upload(client, auth_headers)
    with client.app.state.db_session_factory() as session:
        book = session.get(BookRecord, bid)
        Path(client.app.state.settings.storage_root, book.original_file_path).write_bytes(
            make_minimal_epub_bytes(chapter_texts=['替换了全部正文。']))
    result = check(client, auth_headers, bid)
    assert not result['in_sync']
    assert 'chapter_content_mismatch:1' in result['issues']
    with client.app.state.db_session_factory() as session:
        asset = session.scalar(select(BookAssetRecord).where(
            BookAssetRecord.book_id == bid, BookAssetRecord.asset_type == 'text_chapter'))
        Path(client.app.state.settings.storage_root, asset.path).unlink()
    result = check(client, auth_headers, bid)
    assert not result['in_sync'] and 'reader_chapter_missing:1' in result['issues']


def test_reconciliation_refuses_missing_episode_stale_revision_and_live_worker(client, auth_headers):
    bid = upload(client, auth_headers)
    jid = make_job(client, bid, indexes=(2,))
    body = request(client, auth_headers, bid, jid)
    response = client.post(f'/api/v1/translations/{jid}/reconcile', headers=auth_headers, json=body)
    assert response.status_code == 409 and response.json()['detail']['error_code'] == 'publication_coverage_unproven'
    assert client.get(f'/api/v1/translations/{jid}', headers=auth_headers).json()['status'] == 'failed'
    body['expected_book_revision'] = '0' * 64
    assert client.post(f'/api/v1/translations/{jid}/reconcile', headers=auth_headers, json=body).status_code == 409
    with client.app.state.db_session_factory() as session:
        session.get(Job, jid).lease_owner = 'active-worker'
        session.commit()
    assert client.post(f'/api/v1/translations/{jid}/reconcile', headers=auth_headers, json=body).status_code == 409


def test_source_export_uses_snapshot_position_not_source_episode_number(client, auth_headers):
    bid = upload(client, auth_headers)
    jid = make_job(client, bid, indexes=(71, 72))
    with client.app.state.db_session_factory() as session:
        job = session.get(Job, jid)
        root = Path(client.app.state.settings.storage_root, 'translation-v2', job.user_id, jid)
    data = {'index': 71, 'title': '第71話', 'url': SOURCE + '/episodes/71', 'paragraphs': ['原文。']}
    snapshot(root / 'source' / '00001.json', data)
    base = f'/api/v1/translations/{jid}/external'
    manifest = client.get(base, headers=auth_headers)
    assert manifest.status_code == 200, manifest.text
    assert [e['cached'] for e in manifest.json()['episodes']] == [True, False]
    result = client.get(base + '/chapters/71', headers=auth_headers)
    assert result.status_code == 200 and result.json()['paragraphs'] == ['原文。']
    assert 'SECRET' not in manifest.text + result.text
    assert client.get(base + '/chapters/72', headers=auth_headers).status_code == 409
    assert client.get(base + '/chapters/73', headers=auth_headers).status_code == 404
    path = root / 'source' / '00001.json'
    damaged = json.loads(path.read_text(encoding='utf-8'))
    damaged['value']['paragraphs'] = ['篡改']
    path.write_text(json.dumps(damaged), encoding='utf-8')
    assert client.get(base + '/chapters/71', headers=auth_headers).status_code == 409
    path.write_text('[]', encoding='utf-8')
    assert client.get(base + '/chapters/71', headers=auth_headers).status_code == 409


def test_read_key_cannot_complete_and_book_scoped_key_cannot_read_other_book(client, auth_headers):
    first, second = upload(client, auth_headers), upload(client, auth_headers)
    jid = make_job(client, first)
    token = client.post('/api/v1/auth/api-tokens', headers=auth_headers, json={
        'name': 'readonly', 'permissions': ['book_read'], 'book_id': first}).json()['token']
    headers = {'Authorization': 'Bearer ' + token}
    assert client.get(f'/api/v1/books/{first}/publication-check', headers=headers).status_code == 200
    assert client.get(f'/api/v1/books/{second}/publication-check', headers=headers).status_code == 403
    assert client.get(f'/api/v1/translations/{jid}/external', headers=headers).status_code == 200
    assert client.post(f'/api/v1/translations/{jid}/reconcile', headers=headers,
        json=request(client, auth_headers, first, jid)).status_code == 403


def test_duplicate_numbering_cannot_prove_source_coverage(client, auth_headers):
    from app.modules.translations.external_completion import publication_evidence
    from app.modules.books.publication_check import PublicationChapter
    from fastapi import HTTPException
    import pytest
    bid = upload(client, auth_headers)
    jid = make_job(client, bid, indexes=(1, 2))
    with client.app.state.db_session_factory() as session:
        job = session.get(Job, jid)
        duplicate = dict(job.catalog_json[1], title='第1話')
        job.catalog_json = [job.catalog_json[0], duplicate]
        job.metadata_json = {'episodes': job.catalog_json}
        with pytest.raises(HTTPException):
            publication_evidence(job, [PublicationChapter(index=1, title='第1话', content_hash='abc')])


def test_scoped_manager_cannot_relink_whole_book_task_to_another_book(client, auth_headers):
    first, second = upload(client, auth_headers), upload(client, auth_headers)
    jid = make_job(client, first)
    with client.app.state.db_session_factory() as session:
        session.get(Job, jid).job_kind = 'whole_book'
        session.commit()
    token = client.post('/api/v1/auth/api-tokens', headers=auth_headers, json={
        'name': 'scoped manager', 'permissions': ['book_read', 'book_manage'], 'book_id': first}).json()['token']
    result = client.post(f'/api/v1/translations/{jid}/reconcile', headers={'Authorization': 'Bearer ' + token},
        json=request(client, auth_headers, second, jid))
    assert result.status_code == 403


@pytest.mark.parametrize('stamp', ['2026-10-22 12:38:28', '2026-10-22T12:38:28+00:00',
    '2026-10-22 12:38:28.123'])
def test_legacy_sql_timestamps_support_reprocess_and_reconciliation(client, auth_headers, stamp):
    from sqlalchemy import text
    bid = upload(client, auth_headers)
    jid = make_job(client, bid)
    with client.app.state.db_session_factory() as session:
        session.execute(text('UPDATE books SET updated_at=:stamp WHERE id=:id'), {'stamp': stamp, 'id': bid})
        session.execute(text('UPDATE whole_book_translation_jobs SET updated_at=:stamp WHERE id=:id'),
            {'stamp': stamp, 'id': jid})
        session.commit()
    response = client.post(f'/api/v1/uploads/books/{bid}/reprocess', headers=auth_headers)
    assert response.status_code == 200, response.text
    task = client.get(f"/api/v1/uploads/tasks/{response.json()['task_id']}", headers=auth_headers).json()
    assert task['status'] == 'ready', task
    assert check(client, auth_headers, bid)['in_sync']
    response = client.post(f'/api/v1/translations/{jid}/reconcile', headers=auth_headers,
        json=request(client, auth_headers, bid, jid))
    assert response.status_code == 200, response.text
