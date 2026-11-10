from datetime import datetime, timezone
from typing import cast
from uuid import uuid4

from app.modules.books.domain import Book, BookKind, ReaderType


def create_uploaded_book(
    *,
    author: str,
    book_id: str | None = None,
    file_ext: str | None = None,
    file_label: str,
    file_size: int | None = None,
    kind: str,
    mime_type: str | None = None,
    original_file_path: str | None = None,
    owner_id: str,
    reader_type: str,
    tags: tuple[str, ...],
    title: str,
) -> Book:
    now = datetime.now(timezone.utc)
    return Book(
        id=book_id or str(uuid4()),
        owner_id=owner_id,
        title=title,
        subtitle=file_label,
        author=author,
        kind=cast(BookKind, kind),
        reader_type=cast(ReaderType, reader_type),
        tags=tags,
        description="",
        # Uploaded books start as "processing"; the upload processor flips them to
        # "ready" (or "failed") once parsing finished, so a dead worker can no
        # longer leave an unparsed book that pretends to be readable.
        status="processing",
        publication_status="completed",
        public_status="private",
        progress_percent=0,
        current_chapter="待开始",
        rating=0,
        readers_label="仅自己",
        favorite=False,
        created_at=now,
        updated_at=now,
        original_file_path=original_file_path,
        file_ext=file_ext,
        file_size=file_size,
        mime_type=mime_type,
    )


def create_seed_books(owner_id: str) -> list[Book]:
    now = datetime.now(timezone.utc)
    return [
        Book(
            id="b1",
            owner_id=owner_id,
            title="她与星光的告白",
            subtitle="在晚风与星光里相遇",
            author="北岛风眠",
            kind="novel",
            reader_type="epub",
            tags=("百合", "治愈", "校园", "日常"),
            description="少女们在星光和晚风中相遇，学会把喜欢说出口。",
            status="ready",
            publication_status="completed",
            public_status="private",
            progress_percent=60,
            current_chapter="第23章 / 逐梦之下",
            rating=9.6,
            readers_label="仅自己",
            favorite=True,
            created_at=now,
            updated_at=now,
        ),
        Book(
            id="b2",
            owner_id=owner_id,
            title="月光与薄樱",
            subtitle="温柔慢热的双向奔赴",
            author="浅川未央",
            kind="novel",
            reader_type="epub",
            tags=("百合", "慢热", "轻小说"),
            description="樱花季的旧车站，两个女孩因为一本手账重新相遇。",
            status="ready",
            publication_status="completed",
            public_status="private",
            progress_percent=18,
            current_chapter="第8章 / 旧车站",
            rating=9.4,
            readers_label="仅自己",
            favorite=False,
            created_at=now,
            updated_at=now,
        ),
        Book(
            id="b3",
            owner_id=owner_id,
            title="夏日回声",
            subtitle="海边、社团与未完成的约定",
            author="羽生晴",
            kind="manga",
            reader_type="comic",
            tags=("漫画", "百合", "青春"),
            description="海边小镇摄影社里，沉默的转学生和开朗的社长一起寻找夏天的声音。",
            status="ready",
            publication_status="completed",
            public_status="private",
            progress_percent=32,
            current_chapter="第12话 / 蓝色坡道",
            rating=9.5,
            readers_label="仅自己",
            favorite=True,
            created_at=now,
            updated_at=now,
        ),
    ]
