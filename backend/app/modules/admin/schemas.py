from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict


class AdminUserPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    account_number: int | None = None
    email: str
    nickname: str
    role: str
    status: str
    avatar: str | None = None
    created_at: datetime
    updated_at: datetime


class UpdateUserStatusRequest(BaseModel):
    status: Literal["active", "disabled"]


class AdminSystemTableStat(BaseModel):
    name: str
    rows: int


class AdminSystemIssue(BaseModel):
    code: str
    severity: Literal["info", "warning", "danger"]
    title: str
    detail: str
    count: int = 0


class AdminSystemReport(BaseModel):
    database_engine: str
    database_path: str | None = None
    database_size_bytes: int = 0
    database_auxiliary_size_bytes: int = 0
    storage_root: str
    storage_size_bytes: int = 0
    sqlite_journal_mode: str | None = None
    sqlite_foreign_keys: bool | None = None
    sqlite_quick_check: str | None = None
    table_stats: list[AdminSystemTableStat]
    issues: list[AdminSystemIssue]
    checked_at: datetime


class AdminBackupInfo(BaseModel):
    filename: str
    size_bytes: int
    created_at: datetime
    format_version: int = 0
    database_engine: str = "unknown"
    storage_size_bytes: int = 0


class AdminBackupListResponse(BaseModel):
    backups: list[AdminBackupInfo]
