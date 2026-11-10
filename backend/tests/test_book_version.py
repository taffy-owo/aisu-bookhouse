from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient


def test_book_version_matches_reader_while_progress_keeps_its_own_time(client: TestClient, auth_headers: dict[str, str]) -> None:
    resource = client.get('/api/v1/books/b2/reader', headers=auth_headers).json()
    version = resource['version']
    progress_time = datetime.now(timezone.utc) + timedelta(minutes=2)
    saved = client.put('/api/v1/books/b2/progress', headers=auth_headers, json={
        'reader_type': 'epub', 'chapter_index': 2, 'progress_percent': 45,
        'updated_at': progress_time.isoformat(),
    })
    assert saved.status_code == 200
    for endpoint in ['/api/v1/books/b2', '/api/v1/books/b2/reader/startup', '/api/v1/books', '/api/v1/books/overview']:
        response = client.get(endpoint, headers=auth_headers)
        assert response.status_code == 200
        payload = response.json()
        book = payload['book'] if endpoint.endswith('startup') else next((b for b in payload.get('items', []) if b['id'] == 'b2'), payload)
        assert book['version'] == version
        assert datetime.fromisoformat(book['updated_at'].replace('Z', '+00:00')) == progress_time
        assert book['progress_percent'] == 45
    reset = client.put('/api/v1/books/b2/reading-status', headers=auth_headers, json={'finished': False})
    assert reset.status_code == 200
    assert reset.json()['version'] == version
    assert reset.json()['progress_percent'] == 0


def test_metadata_version_advances_even_when_reading_time_is_ahead(client: TestClient, auth_headers: dict[str, str]) -> None:
    original = client.get('/api/v1/books/b2', headers=auth_headers).json()
    progress = client.put('/api/v1/books/b2/progress', headers=auth_headers, json={
        'reader_type': 'epub', 'progress_percent': 45,
        'updated_at': (datetime.now(timezone.utc) + timedelta(minutes=2)).isoformat(),
    }).json()
    changed = client.patch('/api/v1/books/b2', headers=auth_headers, json={
        'title': '新版书名', 'expected_updated_at': original['version'],
    })
    assert changed.status_code == 200
    assert changed.json()['title'] == '新版书名'
    assert changed.json()['version'] != original['version']
    assert changed.json()['updated_at'] == progress['updated_at']
    resource = client.get('/api/v1/books/b2/reader', headers=auth_headers).json()
    assert resource['version'] == changed.json()['version']
    stale = client.patch('/api/v1/books/b2', headers=auth_headers, json={
        'title': '旧请求', 'expected_updated_at': original['version'],
    })
    assert stale.status_code == 409
