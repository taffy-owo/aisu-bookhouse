"""Match translation attempts by their source chapters, not just their book."""

from app.modules.books.source_identity import source_url_identity
from app.modules.translations.models import WholeBookTranslationJobRecord


def source_episode_urls(record: WholeBookTranslationJobRecord) -> list[str]:
    entries = record.catalog_json or []
    urls = [source_url_identity(e.get("url")) for e in entries if isinstance(e, dict) and e.get("url")]
    if record.total_chapters <= 0 or len(urls) != record.total_chapters or len(set(urls)) != len(urls):
        return []
    return urls


def covers_failed_attempt(failed: WholeBookTranslationJobRecord, published: WholeBookTranslationJobRecord) -> bool:
    required = source_episode_urls(failed)
    same_work = (
        bool(failed.book_id) and published.book_id == failed.book_id
        if failed.job_kind == "source_update"
        else source_url_identity(published.source_url) == source_url_identity(failed.source_url)
    )
    return bool(
        required
        and same_work
        and published.id != failed.id
        and published.status in {"ready", "completed"}
        and published.completed_chapters == published.total_chapters
        and published.updated_at > failed.updated_at
        and published.job_kind == failed.job_kind
        and set(required).issubset(source_episode_urls(published))
    )
