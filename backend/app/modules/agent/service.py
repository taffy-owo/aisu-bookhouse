from dataclasses import asdict, replace
from datetime import datetime, timezone
from hashlib import sha256
import json
import logging
import os
from pathlib import Path
import re
import shutil
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, defer

from app.core.config import Settings
from app.core.storage import StorageLimitExceededError, get_storage_root, resolve_storage_path, write_bytes_file
from app.modules.agent.models import AgentChapterRecord, AgentProjectRecord
from app.modules.agent.schemas import ChapterPublic, ProjectPublic, VerificationResult, PublicationCheck, PublicationMetadata, PublishRequest, xml_text
from app.modules.book_assets.repository import SqlAlchemyBookAssetRepository, asset_to_record
from app.modules.books.factory import create_uploaded_book
from app.modules.books.mappers import book_to_record
from app.modules.books.models import BookRecord, BookTranslationContextRecord
from app.modules.processing.service import run_processor, validate_processing_result_files
from app.modules.translations.epub import build_translation_epub
from app.modules.translations.source_text import SourceChapter
from app.modules.uploads.schemas import WorkSourceEpisode, WorkSourceMetadata
from app.modules.uploads.source_urls import normalize_work_source_url


logger = logging.getLogger(__name__)
MAX_PROJECT_CHARACTERS = 20_000_000


def fingerprint(value: object) -> str:
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def lock_project(project: AgentProjectRecord, session: Session) -> None:
    # An UPDATE locks on SQLite as well as PostgreSQL. Keep it until commit so
    # chapter replacement and publication cannot race across server workers.
    session.execute(update(AgentProjectRecord).where(AgentProjectRecord.id == project.id)
                    .values(updated_at=datetime.now(timezone.utc)))
    session.refresh(project)
    if reauthorize := session.info.get("agent_reauthorize"):
        session.expire_all()
        reauthorize()


def require_draft(project: AgentProjectRecord) -> None:
    if project.status != "draft":
        raise HTTPException(409, "项目已入库，译文已冻结")


def chapters_for(project_id: str, session: Session) -> list[AgentChapterRecord]:
    return list(session.scalars(select(AgentChapterRecord).options(defer(AgentChapterRecord.source_json)).where(
        AgentChapterRecord.project_id == project_id).order_by(AgentChapterRecord.index)))


def project_public(project: AgentProjectRecord, session: Session) -> ProjectPublic:
    return ProjectPublic(
        id=project.id, status=project.status, revision=project.revision,
        metadata=project.metadata_json, prompt=project.prompt, context=project.context_json,
        chapters=[{"index": c.index, "source_hash": c.source_hash, "translation_hash": c.translation_hash}
                  for c in session.execute(select(AgentChapterRecord.index, AgentChapterRecord.source_hash,
                                                  AgentChapterRecord.translation_hash).where(AgentChapterRecord.project_id == project.id)
                                           .order_by(AgentChapterRecord.index))],
        book_id=project.book_id, created_at=project.created_at, updated_at=project.updated_at,
    )


def chapter_public(chapter: AgentChapterRecord) -> ChapterPublic:
    return ChapterPublic(index=chapter.index, source=chapter.source_json, source_hash=chapter.source_hash,
                         translation=chapter.translation_json, translation_hash=chapter.translation_hash)


def validate_episode(metadata: WorkSourceMetadata, episode: WorkSourceEpisode) -> None:
    # Catalog URLs also come from remote pages; never trust an arbitrary href.
    parsed = urlsplit(episode.url)
    if parsed.scheme != "https" or parsed.port not in {None, 443} or parsed.username or parsed.password or parsed.fragment:
        raise HTTPException(502, "来源目录含不安全的章节地址")
    source_host = urlsplit(metadata.source_url).hostname
    allowed_hosts = {source_host}
    if metadata.source in {"kakuyomu", "hameln", "pixiv"}:
        allowed_hosts.update({source_host.removeprefix("www."), "www." + source_host.removeprefix("www.")})
    if parsed.hostname not in allowed_hosts or (parsed.query and metadata.source != "pixiv"):
        raise HTTPException(502, "章节地址不是当前来源的直接链接")
    target = normalize_work_source_url(episode.url)
    if target.provider != metadata.source:
        raise HTTPException(502, "章节来源与作品不一致")
    if metadata.source == "pixiv":
        if target.kind != "novel":
            raise HTTPException(502, "Pixiv 目录含无效章节地址")
    elif target.source_url != metadata.source_url:
        raise HTTPException(502, "章节不属于当前作品")


def validate_catalog(metadata: WorkSourceMetadata) -> None:
    json.dumps(metadata.model_dump(), ensure_ascii=False, allow_nan=False).encode("utf-8")
    episodes = metadata.episodes
    if not episodes or len(episodes) > 2000 or len(episodes) != metadata.episode_count:
        raise HTTPException(422, "来源目录不完整、为空或超过 2000 章")
    if [e.index for e in episodes] != list(range(1, len(episodes) + 1)) or len({e.url for e in episodes}) != len(episodes):
        raise HTTPException(422, "来源目录含重复章节或顺序不完整")
    for episode in episodes:
        validate_episode(metadata, episode)


def source_data(chapter: SourceChapter) -> dict:
    if not chapter.paragraphs or any(not p.strip() for p in chapter.paragraphs):
        raise HTTPException(502, "来源章节为空")
    if sum(map(len, chapter.paragraphs)) > 1_000_000 or len(chapter.paragraphs) > 10_000:
        raise HTTPException(422, "来源章节超过单章限制")
    data = asdict(chapter)
    json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
    return data


def normalized_reader_text(title: str, paragraphs: list[str]) -> str:
    return "\n\n".join(line.strip() for value in [title, *paragraphs] for line in value.splitlines() if line.strip())


def asset_issues(assets, chapters: list[AgentChapterRecord], settings: Settings) -> list[str]:
    text_assets = sorted((a for a in assets if a.asset_type == "text_chapter"), key=lambda a: a.index or 0)
    if [a.index for a in text_assets] != [c.index for c in chapters]:
        return ["入库章节数量或顺序与译文不一致"]
    issues = []
    root = get_storage_root(settings)
    for asset, chapter in zip(text_assets, chapters):
        translation = chapter.translation_json
        if not translation:
            issues.append(f"第 {chapter.index} 章缺少译文")
            continue
        try:
            actual_path = resolve_storage_path(root, asset.path)
            if actual_path.stat().st_size > 8 * 1024 * 1024:
                raise ValueError("oversized chapter")
            actual = actual_path.read_text(encoding="utf-8")
        except (OSError, UnicodeError, ValueError):
            issues.append(f"第 {chapter.index} 章无法读回")
            continue
        expected = normalized_reader_text(translation["title"], translation["paragraphs"])
        if actual != expected or asset.metadata.get("title") != translation["title"]:
            issues.append(f"第 {chapter.index} 章标题或正文与提交内容不一致")
        if sidecar := asset.metadata.get("blocks_path"):
            try:
                sidecar_path = resolve_storage_path(root, sidecar)
                if sidecar_path.stat().st_size > 8 * 1024 * 1024:
                    raise ValueError("oversized sidecar")
                blocks = json.loads(sidecar_path.read_text(encoding="utf-8"))["blocks"]
                displayed = " ".join(b["text"] for b in blocks)
                if re.sub(r"\s+", " ", displayed).strip() != re.sub(r"\s+", " ", expected).strip():
                    raise ValueError("reader text mismatch")
                for block in blocks:
                    if block.get("spans") and "".join(s["text"] for s in block["spans"]) != block["text"]:
                        raise ValueError("reader spans mismatch")
            except (OSError, ValueError, KeyError, TypeError):
                issues.append(f"第 {chapter.index} 章富文本与提交内容不一致")
    return issues


def verify_project(project: AgentProjectRecord, session: Session, settings: Settings) -> VerificationResult:
    expected_count = len(project.metadata_json["episodes"])
    chapters = chapters_for(project.id, session)
    assets = []
    issues = []
    book = session.get(BookRecord, project.book_id) if project.book_id else None
    if not book or book.owner_id != project.owner_id or book.status != "ready":
        issues.append("译本尚未入库或已不可用")
    else:
        assets = SqlAlchemyBookAssetRepository(session).list_by_book(book.id, "text_chapter")
        issues.extend(asset_issues(assets, chapters, settings))
        manifest = project.publication_json
        if not manifest:
            issues.append("缺少入库校验清单")
        else:
            if book.original_file_path != manifest.get("original_path"):
                issues.append("EPUB 文件引用已改变")
            if asset_signature(assets) != manifest.get("assets"):
                issues.append("阅读器的章节或富文本引用已改变")
            root = get_storage_root(settings)
            for file in manifest.get("files", []):
                try:
                    path = resolve_storage_path(root, file["path"])
                    if path.stat().st_size != file["size"] or file_digest(path) != file["sha256"]:
                        issues.append(f"入库文件校验失败：{file['label']}")
                except (OSError, ValueError):
                    issues.append(f"入库文件无法读取：{file['label']}")
        for field in ("title", "author", "description", "source_url"):
            if getattr(book, field) != project.metadata_json[field]:
                issues.append(f"书籍信息与项目不一致：{field}")
        if list(book.tags) != project.metadata_json.get("tags", []):
            issues.append("书籍信息与项目不一致：tags")
    if len(chapters) != expected_count or any(not c.translation_json for c in chapters):
        issues.append("项目仍有未完成章节")
    for chapter in chapters:
        if chapter.translation_json and fingerprint(chapter.translation_json) != chapter.translation_hash:
            issues.append(f"第 {chapter.index} 章译文存档校验失败")
    return VerificationResult(
        verified=not issues, book_id=project.book_id,
        book_path=f"/books/{project.book_id}" if project.book_id else None,
        expected_chapters=expected_count, actual_chapters=len(assets), issues=issues,
    )


def file_digest(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def asset_signature(assets) -> list[dict]:
    return [{"index": a.index, "path": a.path, "metadata": a.metadata}
            for a in sorted(assets, key=lambda a: a.index or 0) if a.asset_type == "text_chapter"]


def publication_manifest(book, assets, settings: Settings) -> dict:
    root = get_storage_root(settings)
    files = []
    paths = [("EPUB", book.original_file_path)]
    for asset in assets:
        paths.append((f"第 {asset.index} 章正文", asset.path))
        if sidecar := asset.metadata.get("blocks_path"):
            paths.append((f"第 {asset.index} 章富文本", sidecar))
    for label, relative in paths:
        path = resolve_storage_path(root, relative)
        files.append({"label": label, "path": relative, "size": path.stat().st_size, "sha256": file_digest(path)})
    return {"version": 1, "original_path": book.original_file_path, "assets": asset_signature(assets), "files": files}


def cleanup_attempt(settings: Settings, owner_id: str, book_id: str, attempt: str) -> None:
    root = get_storage_root(settings)
    # Only this invocation's random attempt directories are eligible. Never
    # remove another publisher's files or the book's shared parent directory.
    for kind in ("originals", "processed"):
        for relative in (Path(kind) / owner_id / attempt, Path(kind) / owner_id / book_id / attempt):
            path = resolve_storage_path(root, relative)
            try:
                if path.is_dir():
                    shutil.rmtree(path)
            except OSError:
                logger.warning("Could not clean agent publication attempt %s", attempt)


def publication_check(project: AgentProjectRecord, session: Session) -> PublicationCheck:
    metadata = PublicationMetadata(**project.metadata_json)
    expected = len(project.metadata_json["episodes"])
    rows = session.execute(select(AgentChapterRecord.index, AgentChapterRecord.translation_hash).where(
        AgentChapterRecord.project_id == project.id)).all()
    translated = {row.index for row in rows if row.translation_hash}
    issues, notices = [], []
    if translated != {episode["index"] for episode in project.metadata_json["episodes"]}:
        issues.append("尚有章节未翻译，不能入库")
    for name, value in metadata.model_dump().items():
        if name == "source_url":
            continue
        if name == "tags":
            if len(value) > 64 or any(not tag.strip() or len(tag) > 255 for tag in value):
                issues.append("标签不符合字段限制：tags")
            for tag in value:
                try:
                    xml_text(tag)
                except ValueError:
                    issues.append("标签含无效字符：tags")
            continue
        if (name in {"title", "author"} and (not value.strip() or len(value) > 255)) or (name == "description" and len(value) > 5000):
            issues.append(f"书籍信息不符合字段限制：{name}")
        try:
            xml_text(value)
        except ValueError:
            issues.append(f"书籍信息含无效字符：{name}")
    if re.search(r"[ぁ-ゖァ-ヺ]", metadata.title):
        notices.append("书名仍含日文假名；如需中文书名，请在发布前保存 title")
    if re.search(r"[ぁ-ゖァ-ヺ]", metadata.description):
        notices.append("简介仍含日文假名；如需中文简介，请在发布前保存 description")
    if any(re.search(r"[ぁ-ゖァ-ヺ]", tag) for tag in metadata.tags):
        notices.append("标签仍含日文假名；如需中文标签，请在发布前保存 tags")
    if not project.context_json:
        notices.append("尚未保存术语表或文风上下文，可通过 PATCH 项目保存 context")
    return PublicationCheck(project_id=project.id, revision=project.revision,
        metadata_digest=fingerprint(metadata.model_dump()), metadata=metadata,
        expected_chapters=expected, translated_chapters=len(translated), ready=not issues,
        issues=issues, notices=notices, context_saved=bool(project.context_json))


def publish_project(project: AgentProjectRecord, session: Session, settings: Settings, payload: PublishRequest | None = None) -> VerificationResult:
    if project.status == "published":
        result = verify_project(project, session, settings)
        session.commit()
        return result
    require_draft(project)
    from app.modules.translations.overlap import require_new_source_available, lock_source_owner
    require_new_source_available(session, project.owner_id, project.metadata_json['source_url'], project_id=project.id)
    revision = project.revision
    if payload and (payload.expected_revision != revision or payload.metadata_digest != publication_check(project, session).metadata_digest):
        raise HTTPException(409, "发布前项目或书籍信息已变化，请重新检查")
    total = session.scalar(select(func.sum(AgentChapterRecord.translation_characters))
                           .where(AgentChapterRecord.project_id == project.id)) or 0
    if total > MAX_PROJECT_CHARACTERS:
        raise HTTPException(413, "译文总量超过单项目 2000 万字符限制")
    chapters = chapters_for(project.id, session)
    metadata = WorkSourceMetadata.model_validate(project.metadata_json)
    if len(metadata.title) > 255 or len(metadata.author) > 255:
        raise HTTPException(422, "请先将书名和作者编辑到 255 字以内")
    if [c.index for c in chapters] != [e.index for e in metadata.episodes] or any(not c.translation_json for c in chapters):
        raise HTTPException(409, "尚有章节未翻译，不能入库")
    for chapter in chapters:
        if fingerprint(chapter.translation_json) != chapter.translation_hash:
            raise HTTPException(409, f"第 {chapter.index} 章译文存档校验失败")
    try:
        for value in (metadata.title, metadata.author, metadata.description):
            xml_text(value)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    book_id = str(uuid5(NAMESPACE_URL, f"aisu-agent:{project.owner_id}:{project.id}"))
    owner_id = project.owner_id
    attempt = str(uuid4())
    committed = False
    # Release the read transaction/connection before expensive EPUB processing.
    # Changes during this phase are caught by the revision check at commit.
    session.commit()
    try:
        data = build_translation_epub(title=metadata.title, author=metadata.author,
                                      description=metadata.description, source_url=metadata.source_url,
                                      tags=metadata.tags,
                                      chapters=[c.translation_json for c in chapters])
        stored = write_bytes_file(data=data, relative_path=Path("originals") / owner_id / attempt / "original.epub", settings=settings)
        book = create_uploaded_book(
            book_id=attempt, owner_id=owner_id, title=metadata.title, author=metadata.author,
            tags=tuple(metadata.tags), file_label="EPUB", file_ext=".epub", file_size=stored.size,
            kind="novel", mime_type="application/epub+zip", original_file_path=stored.relative_path, reader_type="epub",
        ).with_changes(description=metadata.description, language="zh", source_url=metadata.source_url,
                       source_episode_count=metadata.episode_count, source_character_count=metadata.character_count,
                       publication_status=metadata.publication_status, auto_translate_updates=False)
        result = run_processor(book, settings)
        validate_processing_result_files(result, settings)
        issues = asset_issues(result.assets, chapters, settings)
        if issues or result.reader_type not in {None, "epub"}:
            raise HTTPException(422, {"message": "入库核验失败，原文和译文已保留", "issues": issues})
        manifest = publication_manifest(book, result.assets, settings)
        def relocated(path):
            return path.replace(f"/{owner_id}/{attempt}/", f"/{owner_id}/{book_id}/{attempt}/", 1)

        assets = [replace(a, book_id=book_id, path=relocated(a.path), metadata={
            **a.metadata, **({"blocks_path": relocated(a.metadata["blocks_path"])} if a.metadata.get("blocks_path") else {})
        }) for a in result.assets]
        book = book.with_changes(id=book_id, original_file_path=relocated(stored.relative_path),
                                 status="ready", current_chapter=result.current_chapter)
        manifest["original_path"] = book.original_file_path
        manifest["assets"] = asset_signature(assets)
        for entry in manifest["files"]:
            entry["path"] = relocated(entry["path"])
        lock_source_owner(session, owner_id)
        lock_project(project, session)
        if project.status == "published":
            session.commit()
            return verify_project(project, session, settings)
        if project.revision != revision:
            raise HTTPException(409, "入库期间项目发生变化，请检查最新译文后重试")
        require_new_source_available(session, owner_id, metadata.source_url, project_id=project.id)
        if session.get(BookRecord, book_id):
            raise HTTPException(409, "目标书籍已存在，请核验项目记录")
        # Only directory renames and the final database commit need the lock.
        # All compression, parsing and file hashing have already finished.
        root = get_storage_root(settings)
        for kind in ("originals", "processed"):
            old = resolve_storage_path(root, Path(kind) / owner_id / attempt)
            parent = resolve_storage_path(root, Path(kind) / owner_id / book_id)
            parent.mkdir(parents=True, exist_ok=True)
            os.replace(old, resolve_storage_path(root, parent / attempt))
        session.add(book_to_record(book))
        session.flush()
        session.add(BookTranslationContextRecord(book_id=book_id, revision=0,
            prompt=project.prompt, context_json=project.context_json))
        session.add_all([asset_to_record(asset) for asset in assets])
        project.book_id = book_id
        project.status = "published"
        project.publication_json = manifest
        project.revision += 1
        session.commit()
        committed = True
        return verify_project(project, session, settings)
    except StorageLimitExceededError as error:
        session.rollback()
        raise HTTPException(413, "生成文件超过服务器容量限制，译文存档已保留") from error
    except OSError as error:
        session.rollback()
        raise HTTPException(503, "存储暂时不可用，译文存档已保留，可稍后重试") from error
    finally:
        if not committed:
            session.rollback()
            # A database commit can succeed even if its acknowledgement is
            # lost. Read persisted state before deleting any final files.
            try:
                session.refresh(project)
                committed = project.publication_json.get("original_path") == f"originals/{owner_id}/{book_id}/{attempt}/original.epub"
            except Exception:
                committed = True  # uncertain outcome: preserve files
            if not committed:
                cleanup_attempt(settings, owner_id, book_id, attempt)
