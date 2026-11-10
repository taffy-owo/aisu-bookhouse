from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.core.dependencies import get_reading_progress_repository
from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.reading_progress.domain import ReadingProgress
from app.modules.reading_progress.repository import InMemoryReadingProgressRepository, SqlAlchemyReadingProgressRepository


@pytest.mark.parametrize('reader_type,coordinates', [
    ('text', {'chapter_index': 2, 'epub_cfi': 'aisu-scroll:0.45'}),
    ('epub', {'chapter_index': 2, 'chapter_href': 'two.xhtml', 'epub_cfi': 'aisu-scroll:0.45'}),
    ('pdf', {'page_number': 8}),
    ('comic', {'image_index': 9}),
    ('image', {'image_index': 7}),
])
def test_reading_status_returns_the_confirmed_position_in_its_response(
    client: TestClient, auth_headers: dict[str, str], reader_type: str, coordinates: dict,
) -> None:
    owner = client.app.state.settings.default_user_id
    with client.app.state.db_session_factory() as session:
        books = SqlAlchemyBookRepository(session)
        books.save(books.get_by_id('b1').with_changes(reader_type=reader_type))
        SqlAlchemyReadingProgressRepository(session).save(ReadingProgress(
            user_id=owner, book_id='b1', reader_type=reader_type, progress_percent=45,
            updated_at=datetime.now(timezone.utc) + timedelta(minutes=2), **coordinates,
        ))
    for finished in [True, False]:
        response = client.put('/api/v1/books/b1/reading-status', headers=auth_headers, json={'finished': finished})
        assert response.status_code == 200
        body = response.json()
        progress = body['reading_progress']
        assert progress == client.get('/api/v1/books/b1/progress', headers=auth_headers).json()
        assert progress['book_id'] == 'b1'
        assert progress['reader_type'] == body['reader_type'] == reader_type
        assert progress['progress_percent'] == body['progress_percent'] == (100 if finished else 0)
        assert progress['updated_at'] == body['updated_at']
        for key in ['chapter_index', 'page_number', 'image_index', 'chapter_href', 'epub_cfi']:
            assert progress[key] == (coordinates.get(key) if finished else None)


@pytest.mark.parametrize('finished', [True, False])
@pytest.mark.parametrize('winner_percent', [0, 48, 100])
def test_concurrent_device_write_is_not_reported_as_a_successful_status_change(
    client: TestClient, auth_headers: dict[str, str], finished: bool, winner_percent: int,
) -> None:
    class RacingRepository(InMemoryReadingProgressRepository):
        def save(self, progress: ReadingProgress) -> ReadingProgress:
            # Another request commits between this action's read and upsert.
            super().save(replace(progress, progress_percent=winner_percent, chapter_index=2,
                                 updated_at=progress.updated_at + timedelta(seconds=1)))
            return super().save(progress)

    repository = RacingRepository()
    client.app.dependency_overrides[get_reading_progress_repository] = lambda: repository
    response = client.put('/api/v1/books/b2/reading-status', headers=auth_headers, json={'finished': finished})
    assert response.status_code == 409
    assert '其他设备更新' in response.json()['detail']
    progress = repository.get(client.app.state.settings.default_user_id, 'b2')
    assert progress.progress_percent == winner_percent
    assert progress.chapter_index == 2
