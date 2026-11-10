from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.dependencies import get_app_settings, get_current_user, get_db_session, get_user_repository
from app.modules.admin.backups import get_backup_file_path, list_backup_files
from app.modules.admin.maintenance import build_system_report
from app.modules.admin.schemas import (
    AdminBackupInfo,
    AdminBackupListResponse,
    AdminSystemReport,
    AdminUserPublic,
    UpdateUserStatusRequest,
)
from app.modules.users.domain import User
from app.modules.users.repository import UserRepository

router = APIRouter(tags=["admin"])


@router.get("/users", response_model=list[AdminUserPublic])
def list_users(
    current_user: User = Depends(get_current_user),
    user_repository: UserRepository = Depends(get_user_repository),
) -> list[AdminUserPublic]:
    require_admin(current_user)
    return [AdminUserPublic.model_validate(user) for user in user_repository.list_summaries()]


@router.get("/system", response_model=AdminSystemReport)
def get_system_report(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> AdminSystemReport:
    require_admin(current_user)
    return build_system_report(engine=session.get_bind(), session=session, settings=settings)

@router.get("/backups", response_model=AdminBackupListResponse)
def list_backups(
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
) -> AdminBackupListResponse:
    require_admin(current_user)
    return AdminBackupListResponse(backups=list_backup_files(settings))


@router.post("/backups", response_model=AdminBackupInfo)
def create_backup_endpoint(
    current_user: User = Depends(get_current_user),
) -> AdminBackupInfo:
    require_admin(current_user)
    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="A consistent backup requires a maintenance window; use backup_cli create after stopping the app and worker")


@router.get("/backups/{filename}/download")
def download_backup(
    filename: str,
    current_user: User = Depends(get_current_user),
    settings: Settings = Depends(get_app_settings),
) -> FileResponse:
    require_admin(current_user)
    backup_path = get_backup_file_path(settings, filename)
    return FileResponse(
        backup_path,
        filename=backup_path.name,
        media_type="application/zip",
    )


@router.post("/backups/restore")
def restore_backup(
    current_user: User = Depends(get_current_user),
) -> None:
    require_admin(current_user)
    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Online restore is disabled; stop the app and worker, then run backup_cli restore --file PATH --confirm RESTORE")


@router.patch("/users/{user_id}/status", response_model=AdminUserPublic)
def update_user_status(
    user_id: str,
    payload: UpdateUserStatusRequest,
    current_user: User = Depends(get_current_user),
    user_repository: UserRepository = Depends(get_user_repository),
) -> AdminUserPublic:
    require_admin(current_user)
    if user_id == current_user.id and payload.status == "disabled":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot disable your own admin account")

    user = user_repository.get_by_id(user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    updated_user = user_repository.update_fields(
        user_id,
        {"status": payload.status, "updated_at": datetime.now(timezone.utc)},
        expected={"status": user.status},
    )
    if updated_user is None:
        latest_user = user_repository.get_by_id(user_id)
        if latest_user is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="账号状态刚刚发生变化，请刷新后重试")
    return AdminUserPublic.model_validate(updated_user)


def require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
