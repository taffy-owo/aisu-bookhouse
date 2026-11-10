import pytest

from app.modules.book_assets.repository import create_book_asset
from test_reader import make_epub_with_documents


@pytest.mark.parametrize('change', ['body', 'title'])
def test_chapter_update_changes_content_version_without_changing_its_stable_position(client, auth_headers, change):
    upload = client.post('/api/v1/uploads/books', headers=auth_headers,
        files={'file': ('versions.epub', make_epub_with_documents([('第一话', '初始正文。'), ('第二话', '另一话正文。')]), 'application/epub+zip')})
    assert upload.status_code == 200, upload.text
    bid = upload.json()['book_id']
    resource = client.get(f'/api/v1/books/{bid}/reader', headers=auth_headers).json()
    before = client.get(f'/api/v1/books/{bid}/reader/chapters/1', headers=auth_headers).json()
    assert before['content_version'] == resource['toc'][0]['content_version']
    assert len(before['content_version']) == 64
    response = client.put(f'/api/v1/books/{bid}/chapters/1', headers=auth_headers,
        json={'title': '改后的标题' if change == 'title' else before['title'],
              'content': '改后正文。' if change == 'body' else before['content']})
    assert response.status_code == 200, response.text
    after = client.get(f'/api/v1/books/{bid}/reader/startup', headers=auth_headers).json()
    assert after['chapter']['position_key'] == before['position_key']
    assert after['chapter']['content_version'] != before['content_version']
    assert after['chapter']['content_version'] == after['resource']['toc'][0]['content_version']
    assert after['resource']['toc'][1]['content_version'] == resource['toc'][1]['content_version']
    appended = client.post(f'/api/v1/books/{bid}/chapters', headers=auth_headers,
        json={'title': '第三话', 'content': '追加的正文。'})
    assert appended.status_code == 200, appended.text
    latest = client.get(f'/api/v1/books/{bid}/reader', headers=auth_headers).json()
    assert [c['content_version'] for c in latest['toc'][:2]] == [c['content_version'] for c in after['resource']['toc']]


def test_content_version_ignores_reordering_and_unrelated_asset_metadata():
    from app.modules.reader.service import get_reader_chapter_version
    from dataclasses import replace
    asset = create_book_asset(book_id='test', asset_type='text_chapter', index=1, path='immutable/chapter.txt', metadata={'title': '正文', 'text_length': 3})
    version = get_reader_chapter_version(asset)
    assert get_reader_chapter_version(replace(asset, index=2, metadata={**asset.metadata, 'text_length': 999, 'external_source_id': 'x'})) == version
    assert get_reader_chapter_version(replace(asset, path='new/chapter.txt')) != version
