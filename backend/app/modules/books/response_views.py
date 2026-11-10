"""Complete confirmed mutation responses with the same statistics as detail reads."""
from dataclasses import dataclass

from app.modules.book_assets.domain import BookAssetStats
from app.modules.book_assets.repository import BookAssetRepository
from app.modules.books.schemas import BookPublic
from app.modules.comments.repository import PublicCommentRepository
from app.modules.users.repository import UserRepository


@dataclass(frozen=True)
class BookResponseView:
    assets: BookAssetRepository
    comments: PublicCommentRepository
    users: UserRepository

    def complete(self, book: BookPublic) -> BookPublic:
        """Add derived fields after authorization and the write have succeeded.

        Preserve the confirmed state, viewer ownership and reading progress.
        Statistics come from the existing aggregate query; no book files are
        read and an inaccessible book is never looked up through this helper.
        """
        stats = self.assets.stats_by_books([book.id]).get(book.id, BookAssetStats(book_id=book.id))
        owner = self.users.get_by_id(book.owner_id)
        return book.model_copy(update={
            'asset_count': stats.asset_count,
            'chapter_count': stats.chapter_count,
            'page_count': stats.page_count,
            'character_count': stats.character_count,
            'last_content_updated_at': stats.last_content_updated_at,
            'owner_nickname': owner.nickname if owner else None,
            'comment_count': self.comments.count_for_book(book.id),
        })
