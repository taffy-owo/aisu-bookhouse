"""Compare the downloadable original with the catalog actually used by readers."""
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel

from app.core.storage import get_storage_root, resolve_storage_path
from app.modules.book_assets.repository import SqlAlchemyBookAssetRepository
from app.modules.books.chapter_append import get_asset_title
from app.modules.books.continuation import content_revision, fingerprint
from app.modules.books.original_chapter_editor import read_raw_editable_content
from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.processing.service import run_processor, validate_replacement_processing_result
from app.modules.reader.service import filter_readable_text_assets


class PublicationChapter(BaseModel):
    index: int
    title: str
    content_hash: str
    source_url: str | None = None
    source_index: int | None = None


class PublicationCheck(BaseModel):
    book_id: str
    revision: str
    original_sha256: str
    original_chapter_count: int
    reader_chapter_count: int
    in_sync: bool
    issues: list[str]
    chapters: list[PublicationChapter]


def file_digest(path: Path) -> str:
    digest = sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def chapter_proof(asset, index, settings):
    title = get_asset_title(asset, index)
    content = read_raw_editable_content(asset, title, settings)
    source_index = asset.metadata.get('source_catalog_index')
    if not isinstance(source_index, int) or isinstance(source_index, bool) or source_index < 1:
        # Append filenames may contain a reader position or a manual-note index,
        # so they cannot establish an original source chapter identity.
        source_index = None
    url = asset.metadata.get('source_episode_url')
    body_hash = sha256(content.replace('\r\n', '\n').replace('\r', '\n').strip().encode('utf-8')).hexdigest()
    return PublicationChapter(index=index, title=title, content_hash=body_hash,
        source_url=url if isinstance(url, str) else None, source_index=source_index)


def inspect_publication(session, owner_id, book_id, settings):
    book = SqlAlchemyBookRepository(session).get_owned(owner_id, book_id)
    if not book:
        raise HTTPException(404, 'Book not found')
    if book.reader_type not in {'epub', 'text'} or (book.file_ext or '').lower() not in {'.epub', '.txt'}:
        raise HTTPException(409, 'Publication checks require an EPUB or TXT book')
    if not book.original_file_path:
        raise HTTPException(409, 'Original file is missing')
    original = resolve_storage_path(get_storage_root(settings), book.original_file_path)
    if not original.is_file():
        raise HTTPException(409, 'Original file is missing')
    if original.stat().st_size > settings.max_upload_size_bytes:
        raise HTTPException(413, 'Original exceeds the processing size limit')
    digest = file_digest(original)
    assets = filter_readable_text_assets(SqlAlchemyBookAssetRepository(session).list_by_book(book_id, 'text_chapter'))
    issues = []
    online = []
    for index, asset in enumerate(assets, 1):
        try:
            online.append(chapter_proof(asset, index, settings))
        except (OSError, ValueError, HTTPException):
            issues.append(f'reader_chapter_missing:{index}')
    # Parse a private copy using exactly the production parser and archive limits.
    # This GET never rewrites originals, assets, tasks or translation checkpoints.
    try:
        with TemporaryDirectory(prefix='aisu-publication-check-') as directory:
            temporary_settings = replace(settings, storage_root=directory)
            path = Path(directory) / ('original' + original.suffix.lower())
            shutil.copyfile(original, path)
            candidate = book.with_changes(id=str(uuid4()), original_file_path=path.name)
            result = run_processor(candidate, temporary_settings)
            validate_replacement_processing_result(candidate, result, temporary_settings)
            expected = [chapter_proof(a, i, temporary_settings) for i, a in enumerate(
                filter_readable_text_assets([a for a in result.assets if a.asset_type == 'text_chapter']), 1)]
    except (OSError, ValueError, KeyError) as error:
        raise HTTPException(409, 'Original could not be validated; current reader catalog was preserved') from error
    # Old reader-only manual additions are deliberately preserved by reprocessing.
    manual = [proof for asset, proof in zip(assets, online) if asset.metadata.get('source') == 'manual_append'] if len(assets) == len(online) else []
    original_count = len(expected)
    expected.extend(p.model_copy(update={'index': original_count + i}) for i, p in enumerate(manual, 1))
    if file_digest(original) != digest:
        raise HTTPException(409, 'Original changed during verification; retry the check')
    if len(expected) != len(online):
        issues.append('chapter_count_mismatch')
    for position, (left, right) in enumerate(zip(expected, online), 1):
        if (left.title, left.content_hash) != (right.title, right.content_hash):
            issues.append(f'chapter_content_mismatch:{position}')
    if book.file_size != original.stat().st_size:
        issues.append('file_size_mismatch')
    revision = fingerprint({'book': content_revision(book, assets), 'original': digest,
        'reader': [p.model_dump() for p in online], 'issues': issues})
    return PublicationCheck(book_id=book_id, revision=revision, original_sha256=digest,
        original_chapter_count=len(expected), reader_chapter_count=len(assets),
        in_sync=not issues, issues=issues, chapters=expected)
