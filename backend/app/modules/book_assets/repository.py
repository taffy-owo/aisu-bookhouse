from collections.abc import Iterable
from dataclasses import replace
from datetime import datetime, timezone
from typing import Protocol, cast
from uuid import uuid4

from sqlalchemy import case, delete, func, select
from sqlalchemy.orm import Session

from app.modules.book_assets.domain import AssetType, BookAsset, BookAssetStats
from app.modules.book_assets.models import BookAssetRecord
from app.modules.book_assets.text_chapters import is_auxiliary_text_metadata


class BookAssetRepository(Protocol):
    def clear_for_book(self, book_id: str, *, commit: bool = True) -> None:
        ...

    def get_first(self, book_id: str, asset_type: AssetType) -> BookAsset | None:
        ...

    def get_by_index(self, book_id: str, asset_type: AssetType, index: int) -> BookAsset | None:
        ...

    def list_by_book(self, book_id: str, asset_type: AssetType | None = None) -> list[BookAsset]:
        ...

    def list_by_books(self, book_ids: list[str]) -> list[BookAsset]:
        ...

    def stats_by_books(self, book_ids: list[str]) -> dict[str, BookAssetStats]:
        ...

    def save(self, asset: BookAsset) -> BookAsset:
        ...

    def save_many(self, assets: list[BookAsset]) -> list[BookAsset]:
        ...

    def update_metadata(self, asset_id: str, metadata: dict[str, object], *, path: str | None = None) -> BookAsset | None:
        ...

    def update_index(self, asset_id: str, index: int) -> BookAsset | None:
        ...

    def delete(self, asset_id: str, *, commit: bool = True) -> bool:
        ...


class InMemoryBookAssetRepository:
    def __init__(self) -> None:
        self._assets_by_id: dict[str, BookAsset] = {}

    def clear_for_book(self, book_id: str, *, commit: bool = True) -> None:
        self._assets_by_id = {asset_id: asset for asset_id, asset in self._assets_by_id.items() if asset.book_id != book_id}

    def get_first(self, book_id: str, asset_type: AssetType) -> BookAsset | None:
        assets = self.list_by_book(book_id, asset_type)
        return assets[0] if assets else None

    def get_by_index(self, book_id: str, asset_type: AssetType, index: int) -> BookAsset | None:
        return next((asset for asset in self.list_by_book(book_id, asset_type) if asset.index == index), None)

    def list_by_book(self, book_id: str, asset_type: AssetType | None = None) -> list[BookAsset]:
        assets = [asset for asset in self._assets_by_id.values() if asset.book_id == book_id and (asset_type is None or asset.asset_type == asset_type)]
        return sorted(assets, key=lambda asset: asset.index or 0)

    def list_by_books(self, book_ids: list[str]) -> list[BookAsset]:
        book_id_set = set(book_ids)
        assets = [asset for asset in self._assets_by_id.values() if asset.book_id in book_id_set]
        return sorted(assets, key=lambda asset: (asset.book_id, asset.index or 0, asset.created_at))

    def stats_by_books(self, book_ids: list[str]) -> dict[str, BookAssetStats]:
        requested_book_ids = set(book_ids)
        if not requested_book_ids:
            return {}

        stats_by_book_id = {book_id: BookAssetStats(book_id=book_id) for book_id in requested_book_ids}
        for asset in self._assets_by_id.values():
            if asset.book_id not in stats_by_book_id:
                continue
            stats_by_book_id[asset.book_id] = add_asset_to_stats(stats_by_book_id[asset.book_id], asset)
        return exclude_auxiliary_chapter_stats(
            stats_by_book_id,
            ((asset.book_id, asset.metadata) for asset in self._assets_by_id.values()
             if asset.book_id in requested_book_ids and asset.asset_type == "text_chapter"),
        )

    def save(self, asset: BookAsset) -> BookAsset:
        self._assets_by_id[asset.id] = asset
        return asset

    def save_many(self, assets: list[BookAsset]) -> list[BookAsset]:
        for asset in assets:
            self._assets_by_id[asset.id] = asset
        return assets

    def update_metadata(self, asset_id: str, metadata: dict[str, object], *, path: str | None = None) -> BookAsset | None:
        asset = self._assets_by_id.get(asset_id)
        if asset is None:
            return None

        updated_asset = BookAsset(
            id=asset.id,
            book_id=asset.book_id,
            asset_type=asset.asset_type,
            path=asset.path if path is None else path,
            index=asset.index,
            metadata=metadata,
            created_at=asset.created_at,
        )
        self._assets_by_id[asset_id] = updated_asset
        return updated_asset

    def update_index(self, asset_id: str, index: int) -> BookAsset | None:
        asset = self._assets_by_id.get(asset_id)
        if asset is None:
            return None
        updated_asset = BookAsset(
            id=asset.id,
            book_id=asset.book_id,
            asset_type=asset.asset_type,
            path=asset.path,
            index=index,
            metadata=asset.metadata,
            created_at=asset.created_at,
        )
        self._assets_by_id[asset_id] = updated_asset
        return updated_asset

    def delete(self, asset_id: str, *, commit: bool = True) -> bool:
        return self._assets_by_id.pop(asset_id, None) is not None


class SqlAlchemyBookAssetRepository:
    def __init__(self, session: Session, *, autocommit: bool = True) -> None:
        self._session = session
        self._autocommit = autocommit

    def clear_for_book(self, book_id: str, *, commit: bool = True) -> None:
        self._session.execute(delete(BookAssetRecord).where(BookAssetRecord.book_id == book_id))
        if commit and self._autocommit:
            self._session.commit()

    def get_first(self, book_id: str, asset_type: AssetType) -> BookAsset | None:
        record = self._session.scalar(
            select(BookAssetRecord)
            .where(BookAssetRecord.book_id == book_id, BookAssetRecord.asset_type == asset_type)
            .order_by(BookAssetRecord.index.asc().nulls_last(), BookAssetRecord.created_at.asc())
        )
        return record_to_asset(record) if record else None

    def get_by_index(self, book_id: str, asset_type: AssetType, index: int) -> BookAsset | None:
        record = self._session.scalar(
            select(BookAssetRecord).where(BookAssetRecord.book_id == book_id, BookAssetRecord.asset_type == asset_type, BookAssetRecord.index == index)
        )
        return record_to_asset(record) if record else None

    def list_by_book(self, book_id: str, asset_type: AssetType | None = None) -> list[BookAsset]:
        statement = select(BookAssetRecord).where(BookAssetRecord.book_id == book_id)
        if asset_type is not None:
            statement = statement.where(BookAssetRecord.asset_type == asset_type)

        records = self._session.scalars(statement.order_by(BookAssetRecord.index.asc().nulls_last(), BookAssetRecord.created_at.asc())).all()
        return [record_to_asset(record) for record in records]

    def list_by_books(self, book_ids: list[str]) -> list[BookAsset]:
        if not book_ids:
            return []

        records = self._session.scalars(
            select(BookAssetRecord)
            .where(BookAssetRecord.book_id.in_(book_ids))
            .order_by(BookAssetRecord.book_id.asc(), BookAssetRecord.index.asc().nulls_last(), BookAssetRecord.created_at.asc())
        ).all()
        return [record_to_asset(record) for record in records]

    def stats_by_books(self, book_ids: list[str]) -> dict[str, BookAssetStats]:
        requested_book_ids = set(book_ids)
        if not requested_book_ids:
            return {}

        rows = self._session.execute(
            select(
                BookAssetRecord.book_id,
                func.count(BookAssetRecord.id),
                func.sum(case((BookAssetRecord.asset_type == "text_chapter", 1), else_=0)),
                func.sum(case((BookAssetRecord.asset_type.in_(("comic_page", "image_page")), 1), else_=0)),
                func.sum(case((BookAssetRecord.asset_type == "text_chapter", BookAssetRecord.metadata_json["text_length"].as_integer()), else_=0)),
                func.max(BookAssetRecord.created_at),
            )
            .where(BookAssetRecord.book_id.in_(requested_book_ids))
            .group_by(BookAssetRecord.book_id)
        ).all()

        stats_by_book_id = {book_id: BookAssetStats(book_id=book_id) for book_id in requested_book_ids}
        for book_id, asset_count, chapter_count, page_count, character_count, last_content_updated_at in rows:
            stats_by_book_id[book_id] = BookAssetStats(
                book_id=book_id,
                asset_count=int(asset_count or 0),
                chapter_count=int(chapter_count or 0),
                page_count=int(page_count or 0),
                character_count=int(character_count or 0),
                last_content_updated_at=last_content_updated_at,
            )
        text_metadata = self._session.execute(
            select(BookAssetRecord.book_id, BookAssetRecord.metadata_json)
            .where(BookAssetRecord.book_id.in_(requested_book_ids), BookAssetRecord.asset_type == "text_chapter")
        )
        return exclude_auxiliary_chapter_stats(stats_by_book_id, text_metadata)

    def save(self, asset: BookAsset) -> BookAsset:
        record = asset_to_record(asset)
        self._session.add(record)
        if self._autocommit:
            self._session.commit()
        else:
            self._session.flush()
        self._session.refresh(record)
        return record_to_asset(record)

    def save_many(self, assets: list[BookAsset]) -> list[BookAsset]:
        if not assets:
            return []

        records = [asset_to_record(asset) for asset in assets]
        self._session.add_all(records)
        if self._autocommit:
            self._session.commit()
        else:
            self._session.flush()
        for record in records:
            self._session.refresh(record)
        return [record_to_asset(record) for record in records]

    def update_metadata(self, asset_id: str, metadata: dict[str, object], *, path: str | None = None) -> BookAsset | None:
        record = self._session.get(BookAssetRecord, asset_id)
        if record is None:
            return None

        record.metadata_json = metadata
        if path is not None:
            record.path = path
        if self._autocommit:
            self._session.commit()
        else:
            self._session.flush()
        self._session.refresh(record)
        return record_to_asset(record)

    def update_index(self, asset_id: str, index: int) -> BookAsset | None:
        record = self._session.get(BookAssetRecord, asset_id)
        if record is None:
            return None
        record.index = index
        if self._autocommit:
            self._session.commit()
        else:
            self._session.flush()
        self._session.refresh(record)
        return record_to_asset(record)

    def delete(self, asset_id: str, *, commit: bool = True) -> bool:
        result = self._session.execute(delete(BookAssetRecord).where(BookAssetRecord.id == asset_id))
        if commit and self._autocommit:
            self._session.commit()
        return bool(result.rowcount)


def create_book_asset(*, asset_type: AssetType, book_id: str, path: str, index: int | None = None, metadata: dict[str, object] | None = None) -> BookAsset:
    return BookAsset(
        id=str(uuid4()),
        book_id=book_id,
        asset_type=asset_type,
        path=path,
        index=index,
        metadata=metadata or {},
        created_at=datetime.now(timezone.utc),
    )


def asset_to_record(asset: BookAsset) -> BookAssetRecord:
    return BookAssetRecord(
        id=asset.id,
        book_id=asset.book_id,
        asset_type=asset.asset_type,
        path=asset.path,
        index=asset.index,
        metadata_json=asset.metadata,
        created_at=asset.created_at,
    )


def record_to_asset(record: BookAssetRecord) -> BookAsset:
    return BookAsset(
        id=record.id,
        book_id=record.book_id,
        asset_type=cast(AssetType, record.asset_type),
        path=record.path,
        index=record.index,
        metadata=record.metadata_json,
        created_at=record.created_at,
    )


def exclude_auxiliary_chapter_stats(
    stats_by_book_id: dict[str, BookAssetStats],
    text_metadata: Iterable[tuple[str, dict[str, object]]],
) -> dict[str, BookAssetStats]:
    auxiliary_totals: dict[str, tuple[int, int]] = {}
    for book_id, metadata in text_metadata:
        if is_auxiliary_text_metadata(metadata):
            count, characters = auxiliary_totals.get(book_id, (0, 0))
            text_length = metadata.get("text_length")
            auxiliary_totals[book_id] = (count + 1, characters + (text_length if isinstance(text_length, int) else 0))

    for book_id, (count, characters) in auxiliary_totals.items():
        stats = stats_by_book_id[book_id]
        # Match the reader's existing fallback when every text asset is auxiliary.
        if count < stats.chapter_count:
            stats_by_book_id[book_id] = replace(
                stats,
                chapter_count=stats.chapter_count - count,
                character_count=stats.character_count - characters,
            )
    return stats_by_book_id


def add_asset_to_stats(stats: BookAssetStats, asset: BookAsset) -> BookAssetStats:
    chapter_count = stats.chapter_count
    page_count = stats.page_count
    character_count = stats.character_count
    if asset.asset_type == "text_chapter":
        chapter_count += 1
        text_length = asset.metadata.get("text_length")
        if isinstance(text_length, int):
            character_count += text_length
    if asset.asset_type in {"comic_page", "image_page"}:
        page_count += 1

    last_content_updated_at = stats.last_content_updated_at
    if last_content_updated_at is None or asset.created_at > last_content_updated_at:
        last_content_updated_at = asset.created_at

    return BookAssetStats(
        book_id=stats.book_id,
        asset_count=stats.asset_count + 1,
        chapter_count=chapter_count,
        page_count=page_count,
        character_count=character_count,
        last_content_updated_at=last_content_updated_at,
    )
