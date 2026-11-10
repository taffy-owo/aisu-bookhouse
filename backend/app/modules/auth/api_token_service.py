"""Personal API keys authorize explicit operations on account-owned resources."""
from datetime import datetime, timezone
from hashlib import sha256
import re

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.auth.models import ApiTokenRecord

TOKEN_PREFIX = "aisu_api_"
_ID = r"[0-9a-fA-F-]{36}"
_ALLOWED = {
    "GET": [r"uploads/tasks", r"uploads/tasks/" + _ID, r"books/" + _ID,
            r"files/books/" + _ID + r"/(?:original|epub)", r"agent/projects",
            r"agent/projects/" + _ID + r"(?:/chapters/[0-9]+|/verify|/publication-check)?"],
    "POST": [r"uploads/books", r"agent/projects", r"agent/projects/" + _ID + r"/(?:publish|pause|resume)",
             r"agent/projects/" + _ID + r"/chapters/[0-9]+/fetch"],
    "PATCH": [r"agent/projects/" + _ID],
    "PUT": [r"agent/projects/" + _ID + r"/chapters/[0-9]+/translation"],
}
_READ = {
    "GET": [r"books", r"books/(?:overview|source-updates)", r"books/" + _ID,
            r"books/" + _ID + r"/continuation(?:/chapters/[0-9]+)?",
            r"books/" + _ID + r"/translation-context",
            r"books/" + _ID + r"/(?:publication-check|translation-jobs|chapters|chapters/[0-9]+/edit|reader|reader/startup|reader/chapters/[0-9]+|progress|marks)",
            r"translations(?:/notifications|/" + _ID + r"(?:/review|/external(?:/chapters/[0-9]+)?)?)?",
            r"uploads/tasks(?:/" + _ID + r")?",
            r"files/books/" + _ID + r"/(?:original|epub|cover|pdf|pdf-preview|pages/[0-9]+|chapter-images/[0-9]+)"],
}
_APPEND = {"POST": [r"books/" + _ID + r"/(?:continuation|chapters)", r"translations/" + _ID + r"/accept"],
           "PATCH": [r"books/" + _ID + r"/translation-context"]}
_MANAGE = {
    "PATCH": [r"books/" + _ID, r"books/" + _ID + r"/marks/" + _ID,
              r"translations/" + _ID + r"/(?:model|concurrency)"],
    "PUT": [r"books/" + _ID + r"/(?:cover|reading-status|progress|chapters/[0-9]+)"],
    "POST": [r"books/" + _ID + r"/(?:favorite|dislike|marks|source-update/(?:check|acknowledge|translate)|source-catalog/sync)",
             r"books/source-updates/acknowledge", r"uploads/books/" + _ID + r"/reprocess",
             r"uploads/source-metadata", r"translations", r"translations/" + _ID + r"/(?:acknowledge|retry|pause|resume|reject|reconcile)"],
    "DELETE": [r"books/" + _ID + r"/(?:cover|favorite|dislike|marks/" + _ID + r")"],
}
_DELETE = {
    "DELETE": [r"books/" + _ID + r"(?:/chapters/[0-9]+)?", r"translations/(?:completed|" + _ID + r")",
               r"uploads/tasks/completed"],
    "POST": [r"uploads/books/" + _ID + r"/replace"],
}
_SHARE = {method: [r"books/" + _ID + r"/share-request"] for method in ("POST", "DELETE")}
_COMMON = {"GET": [r"auth/api-capabilities"]}
PERMISSION_ROUTES = {"book_import": _ALLOWED, "book_read": _READ, "book_append": _APPEND,
                     "book_manage": _MANAGE, "book_delete": _DELETE, "book_share": _SHARE}


def token_digest(token: str) -> str:
    return sha256(token.encode("utf-8")).hexdigest()


def utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def authenticate_api_token(token: str, session: Session, request: Request | None) -> str:
    record = session.scalar(select(ApiTokenRecord).where(ApiTokenRecord.token_hash == token_digest(token))
        .execution_options(populate_existing=True))
    if not record or record.revoked_at is not None or utc(record.expires_at) <= datetime.now(timezone.utc):
        raise HTTPException(401, "API credential expired or revoked")
    if request is not None:
        request.state.api_book_scope = record.book_id
    # The API prefix and the request method are checked at every authentication,
    # including reauthorization after an expensive project fetch/publication.
    prefix = request.app.state.settings.api_prefix.rstrip("/") + "/" if request else ""
    path = request.url.path if request else ""
    allowed = list(_COMMON.get(request.method, [])) if request else []
    for permission, routes in PERMISSION_ROUTES.items():
        if permission in record.permissions:
            allowed.extend(routes.get(request.method, []) if request else [])
    if not request or not path.startswith(prefix) or not any(
        re.fullmatch(pattern, path[len(prefix):]) for pattern in allowed
    ):
        raise HTTPException(403, "API credential does not allow this operation")
    if request.method == "POST" and path[len(prefix):] == "translations" and "book_import" not in record.permissions:
        raise HTTPException(403, "Creating a new book also requires book_import")
    # Even publicly shared books must belong to this key's account for this
    # integration; browser/public-library access keeps its existing policy.
    relative = path[len(prefix):]
    match = re.fullmatch(r"(?:books|files/books|uploads/books)/(" + _ID + r")(?:/.*)?", relative)
    resource_book_id = match.group(1) if match else None
    job_match = re.fullmatch(r"translations/(" + _ID + r")(?:/.*)?", relative)
    task_match = re.fullmatch(r"uploads/tasks/(" + _ID + r")", relative)
    if job_match or task_match:
        if job_match:
            from app.modules.translations.models import WholeBookTranslationJobRecord
            resource = session.get(WholeBookTranslationJobRecord, job_match.group(1))
        else:
            from app.modules.uploads.models import UploadTaskRecord
            resource = session.get(UploadTaskRecord, task_match.group(1))
        if not resource or resource.user_id != record.user_id:
            raise HTTPException(404, "Task not found")
        resource_book_id = resource.book_id
    introspection = request.method == "GET" and path[len(prefix):] == "auth/api-capabilities"
    if record.book_id and not introspection and resource_book_id != record.book_id:
        raise HTTPException(403, "API credential is restricted to one book")
    if resource_book_id:
        from app.modules.books.models import BookRecord
        book = session.get(BookRecord, resource_book_id)
        if not book or book.owner_id != record.user_id or book.status == "deleted":
            raise HTTPException(404, "Book not found")
    return record.user_id
