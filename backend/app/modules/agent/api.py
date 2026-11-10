from datetime import datetime, timedelta, timezone
from hashlib import sha256
import hmac
import secrets
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
import httpx
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.dependencies import get_app_settings, get_current_user, get_db_session, get_user_from_bearer_token
from app.modules.agent.models import AgentChapterRecord, AgentProjectRecord
from app.modules.agent.schemas import (
    DEFAULT_PROMPT, ChapterPublic, ProjectCreate, ProjectEdit, ProjectPublic, ProjectSummary,
    ProjectToken, TranslationSubmit, VerificationResult, PublicationCheck, PublishRequest,
)
from app.modules.agent import service
from app.modules.agent.routing import AgentRoute
from app.modules.translations.source_text import fetch_source_chapter
from app.modules.uploads.schemas import WorkSourceMetadata
from app.modules.uploads.source_metadata import fetch_work_source_metadata
from app.modules.uploads.source_urls import normalize_work_source_url
from app.modules.users.domain import User
from app.modules.users.models import UserRecord
from app.modules.users.repository import SqlAlchemyUserRepository


router = APIRouter(tags=["agent"], route_class=AgentRoute)
TOKEN_PREFIX = "aisu_agent_"


def authorized_project(
    project_id: UUID, request: Request,
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_db_session),
) -> AgentProjectRecord:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    project = session.get(AgentProjectRecord, str(project_id), populate_existing=True)
    if token.startswith(TOKEN_PREFIX):
        if not project or not project.token_hash or not hmac.compare_digest(project.token_hash, sha256(token.encode()).hexdigest()):
            raise HTTPException(401, "Invalid project token")
        expires = project.token_expires_at
        owner = session.get(UserRecord, project.owner_id, populate_existing=True)
        if not expires or expires.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc) or not owner or owner.status != "active":
            raise HTTPException(401, "Project token expired or revoked")
    else:
        user = get_user_from_bearer_token(token, request.app.state.settings, SqlAlchemyUserRepository(session), session, request)
        if not project or project.owner_id != user.id:
            raise HTTPException(404, "Project not found")
    # Recheck at the eventual write boundary, including after a long fetch or
    # publication. Revocation/disabled accounts must also stop in-flight writes.
    session.info["agent_reauthorize"] = lambda: authorized_project(project_id, request, authorization, session)
    return project


@router.get("/defaults")
def get_defaults() -> dict:
    return {"prompt": DEFAULT_PROMPT, "target_language": "zh", "paragraph_alignment": "one_to_one",
            "source_content_is_data": True, "server_calls_translation_model": False}


def reuse_project(project, owner_id: str, request_hash: str, session: Session) -> ProjectPublic:
    if project.owner_id != owner_id or project.request_hash != request_hash:
        raise HTTPException(409, "request_id 已被另一个请求使用")
    return service.project_public(project, session)


@router.post("/projects", response_model=ProjectPublic)
async def create_project(
    payload: ProjectCreate, user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> ProjectPublic:
    canonical_url = normalize_work_source_url(payload.source_url).source_url
    prompt = payload.prompt if payload.prompt is not None else DEFAULT_PROMPT
    if not prompt.strip():
        raise HTTPException(422, "提示词不能为空白")
    request_hash = service.fingerprint({"source_url": canonical_url, "prompt": prompt})
    existing = session.get(AgentProjectRecord, str(payload.request_id))
    if existing:
        return reuse_project(existing, user.id, request_hash, session)
    try:
        metadata = await fetch_work_source_metadata(canonical_url, public_only=True, flaresolverr_url=settings.flaresolverr_url)
        service.validate_catalog(metadata)
    except (ValueError, httpx.HTTPError) as error:
        raise HTTPException(502, "无法解析来源目录，请稍后重试") from error
    now = datetime.now(timezone.utc)
    if not metadata.original_title:
        metadata = metadata.model_copy(update={"original_title": metadata.title})
    from app.modules.translations.overlap import lock_source_owner, require_new_source_available
    lock_source_owner(session, user.id)
    existing = session.get(AgentProjectRecord, str(payload.request_id), populate_existing=True)
    if existing:
        return reuse_project(existing, user.id, request_hash, session)
    require_new_source_available(session, user.id, metadata.source_url)
    project = AgentProjectRecord(id=str(payload.request_id), owner_id=user.id, request_hash=request_hash,
                                 metadata_json=metadata.model_dump(mode="json"), prompt=prompt,
                                 context_json={}, created_at=now, updated_at=now)
    session.add(project)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        existing = session.get(AgentProjectRecord, str(payload.request_id))
        if existing is None:
            raise
        return reuse_project(existing, user.id, request_hash, session)
    return service.project_public(project, session)


@router.get("/projects", response_model=list[ProjectSummary])
def list_projects(user: User = Depends(get_current_user), session: Session = Depends(get_db_session),
                  offset: int = Query(default=0, ge=0), limit: int = Query(default=20, ge=1, le=100)):
    records = session.execute(select(AgentProjectRecord.id, AgentProjectRecord.status,
                                     AgentProjectRecord.metadata_json["title"].as_string().label("title"),
                                     AgentProjectRecord.metadata_json["source_url"].as_string().label("source_url"),
                                     AgentProjectRecord.book_id, AgentProjectRecord.created_at, AgentProjectRecord.updated_at)
                              .where(AgentProjectRecord.owner_id == user.id)
                              .order_by(AgentProjectRecord.updated_at.desc(), AgentProjectRecord.id).offset(offset).limit(limit))
    return [dict(row._mapping) for row in records]


@router.get("/projects/{project_id}", response_model=ProjectPublic)
def get_project(project: AgentProjectRecord = Depends(authorized_project), session: Session = Depends(get_db_session)):
    return service.project_public(project, session)


@router.post('/projects/{project_id}/pause', response_model=ProjectPublic)
def pause_project(project: AgentProjectRecord = Depends(authorized_project), session: Session = Depends(get_db_session)):
    from app.modules.translations.overlap import lock_source_owner
    lock_source_owner(session, project.owner_id)
    service.lock_project(project, session)
    if project.status == 'published':
        raise HTTPException(409, '已发布项目不能暂停')
    if project.status != 'paused':
        project.status = 'paused'
        project.revision += 1
    session.commit()
    return service.project_public(project, session)


@router.post('/projects/{project_id}/resume', response_model=ProjectPublic)
def resume_project(project: AgentProjectRecord = Depends(authorized_project), session: Session = Depends(get_db_session)):
    from app.modules.translations.overlap import lock_source_owner, require_new_source_available
    lock_source_owner(session, project.owner_id)
    service.lock_project(project, session)
    if project.status == 'published':
        raise HTTPException(409, '已发布项目无需继续')
    require_new_source_available(session, project.owner_id, project.metadata_json['source_url'], project_id=project.id)
    if project.status != 'draft':
        project.status = 'draft'
        project.revision += 1
    session.commit()
    return service.project_public(project, session)


@router.patch("/projects/{project_id}", response_model=ProjectPublic)
def edit_project(payload: ProjectEdit, project: AgentProjectRecord = Depends(authorized_project),
                 session: Session = Depends(get_db_session)):
    service.lock_project(project, session)
    service.require_draft(project)
    if project.revision != payload.expected_revision:
        raise HTTPException(409, "项目已更新，请重新读取后合并修改")
    metadata = dict(project.metadata_json)
    for name in ("title", "author", "description", "tags"):
        value = getattr(payload, name)
        if value is not None:
            metadata[name] = value
    project.metadata_json = metadata
    if payload.prompt is not None:
        if not payload.prompt.strip():
            raise HTTPException(422, "提示词不能为空白")
        project.prompt = payload.prompt
    if payload.context is not None:
        project.context_json = payload.context
    project.revision += 1
    session.commit()
    return service.project_public(project, session)


def owned_project(project_id: UUID, user: User, session: Session) -> AgentProjectRecord:
    project = session.get(AgentProjectRecord, str(project_id))
    if not project or project.owner_id != user.id:
        raise HTTPException(404, "Project not found")
    service.lock_project(project, session)
    return project


@router.post("/projects/{project_id}/token", response_model=ProjectToken)
def rotate_token(project_id: UUID, response: Response, user: User = Depends(get_current_user),
                 session: Session = Depends(get_db_session)):
    project = owned_project(project_id, user, session)
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=30)
    project.token_hash = sha256(token.encode()).hexdigest()
    project.token_expires_at = expires
    session.commit()
    response.headers["Cache-Control"] = "no-store"
    return ProjectToken(token=token, expires_at=expires)


@router.delete("/projects/{project_id}/token", status_code=204)
def revoke_token(project_id: UUID, user: User = Depends(get_current_user), session: Session = Depends(get_db_session)):
    project = owned_project(project_id, user, session)
    project.token_hash = None
    project.token_expires_at = None
    session.commit()


@router.get("/projects/{project_id}/chapters/{index}", response_model=ChapterPublic)
def get_chapter(index: int, project: AgentProjectRecord = Depends(authorized_project),
                session: Session = Depends(get_db_session)):
    chapter = session.get(AgentChapterRecord, (project.id, index))
    if not chapter:
        raise HTTPException(404, "章节原文尚未获取")
    return service.chapter_public(chapter)


@router.post("/projects/{project_id}/chapters/{index}/fetch", response_model=ChapterPublic)
async def fetch_chapter(index: int, project: AgentProjectRecord = Depends(authorized_project),
                        session: Session = Depends(get_db_session), settings: Settings = Depends(get_app_settings)):
    existing = session.get(AgentChapterRecord, (project.id, index))
    if existing:
        return service.chapter_public(existing)
    service.require_draft(project)
    metadata = WorkSourceMetadata.model_validate(project.metadata_json)
    episode = next((e for e in metadata.episodes if e.index == index), None)
    if not episode:
        raise HTTPException(404, "章节不在项目目录中")
    service.validate_episode(metadata, episode)
    try:
        chapter = await fetch_source_chapter(episode, metadata.source, flaresolverr_url=settings.flaresolverr_url, public_only=True)
        data = service.source_data(chapter)
    except (ValueError, httpx.HTTPError) as error:
        raise HTTPException(502, "无法获取章节原文，请稍后重试") from error
    service.lock_project(project, session)
    existing = session.get(AgentChapterRecord, (project.id, index), populate_existing=True)
    if existing:
        session.commit()
        return service.chapter_public(existing)
    service.require_draft(project)
    record = AgentChapterRecord(project_id=project.id, index=index, source_json=data, source_hash=service.fingerprint(data))
    session.add(record)
    project.revision += 1
    session.commit()
    return service.chapter_public(record)


@router.put("/projects/{project_id}/chapters/{index}/translation", response_model=ChapterPublic)
def submit_translation(index: int, payload: TranslationSubmit,
                       project: AgentProjectRecord = Depends(authorized_project), session: Session = Depends(get_db_session)):
    service.lock_project(project, session)
    chapter = session.get(AgentChapterRecord, (project.id, index), populate_existing=True)
    if not chapter:
        raise HTTPException(409, "请先获取章节原文")
    if payload.source_hash != chapter.source_hash:
        raise HTTPException(409, "原文校验值不一致，请重新读取章节")
    if len(payload.paragraphs) != len(chapter.source_json["paragraphs"]):
        raise HTTPException(422, "译文必须与原文逐段对应，不得缺段、合段或增加段落")
    translation = {"title": payload.title, "paragraphs": payload.paragraphs}
    digest = service.fingerprint(translation)
    if digest == chapter.translation_hash:
        session.commit()
        return service.chapter_public(chapter)
    service.require_draft(project)
    if chapter.translation_hash != payload.expected_translation_hash:
        raise HTTPException(409, "译文已存在或被更新，请读取最新版本后显式替换")
    characters = len(payload.title) + sum(map(len, payload.paragraphs))
    total = session.scalar(select(func.sum(AgentChapterRecord.translation_characters))
                           .where(AgentChapterRecord.project_id == project.id)) or 0
    if total - chapter.translation_characters + characters > service.MAX_PROJECT_CHARACTERS:
        raise HTTPException(413, "译文总量超过单项目 2000 万字符限制")
    chapter.translation_json = translation
    chapter.translation_hash = digest
    chapter.translation_characters = characters
    project.revision += 1
    session.commit()
    return service.chapter_public(chapter)


@router.post("/projects/{project_id}/publish", response_model=VerificationResult)
def publish(payload: PublishRequest | None = None, project: AgentProjectRecord = Depends(authorized_project), session: Session = Depends(get_db_session),
            settings: Settings = Depends(get_app_settings)):
    return service.publish_project(project, session, settings, payload=payload)


@router.get("/projects/{project_id}/publication-check", response_model=PublicationCheck)
def publication_check(response: Response, project: AgentProjectRecord = Depends(authorized_project),
    session: Session = Depends(get_db_session)):
    response.headers["Cache-Control"] = "no-store"
    return service.publication_check(project, session)


@router.get("/projects/{project_id}/verify", response_model=VerificationResult)
def verify(project: AgentProjectRecord = Depends(authorized_project), session: Session = Depends(get_db_session),
           settings: Settings = Depends(get_app_settings)):
    return service.verify_project(project, session, settings)
