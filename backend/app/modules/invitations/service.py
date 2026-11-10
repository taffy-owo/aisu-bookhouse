from datetime import datetime, timezone
import secrets
from uuid import uuid4

from app.modules.invitations.domain import Invitation
from app.modules.invitations.repository import InvitationRepository, normalize_invitation_code
from app.modules.invitations.schemas import InvitationPublic, InvitationQuotaPublic
from app.modules.users.domain import User


def create_invitation_for_user(user: User, invitation_repository: InvitationRepository) -> Invitation:
    if user.role != "admin" and invitation_repository.count_used_by_inviter(user.id) >= 1:
        raise ValueError("每个用户只能生成一个邀请码")

    now = datetime.now(timezone.utc)
    try:
        invitation_repository.revoke_available_by_inviter(user.id, commit=False)
        for _attempt in range(8):
            code = build_invitation_code()
            if not invitation_repository.get_by_code(code):
                invitation = invitation_repository.save(
                    Invitation(
                        id=str(uuid4()),
                        code=code,
                        inviter_user_id=user.id,
                        status="available",
                        created_at=now,
                        updated_at=now,
                    ),
                    commit=False,
                )
                invitation_repository.commit()
                return invitation
    except Exception:
        invitation_repository.rollback()
        raise

    raise ValueError("邀请码生成失败，请稍后重试")


def get_invitation_quota(user: User, invitation_repository: InvitationRepository) -> InvitationQuotaPublic:
    invitation = invitation_repository.get_latest_by_inviter(user.id)
    used_count = invitation_repository.count_used_by_inviter(user.id)
    can_create = user.role == "admin" or used_count < 1
    remaining = None if user.role == "admin" else max(0, 1 - used_count)

    return InvitationQuotaPublic(
        can_create=can_create,
        invitation=to_public(invitation) if invitation else None,
        remaining=remaining,
    )


def consume_invitation(code: str, invitee_user_id: str, invitation_repository: InvitationRepository, *, commit: bool = True) -> Invitation:
    invitation = invitation_repository.consume_available(normalize_invitation_code(code), invitee_user_id, commit=commit)
    if not invitation:
        raise ValueError("邀请码无效或已被使用")

    return invitation


def to_public(invitation: Invitation) -> InvitationPublic:
    return InvitationPublic(
        id=invitation.id,
        code=invitation.code,
        inviter_user_id=invitation.inviter_user_id,
        invitee_user_id=invitation.invitee_user_id,
        status=invitation.status,
        created_at=invitation.created_at,
        used_at=invitation.used_at,
    )


def build_invitation_code() -> str:
    token = secrets.token_urlsafe(8).replace("-", "").replace("_", "")
    return token[:10].upper()
