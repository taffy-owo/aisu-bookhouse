from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy.exc import IntegrityError

from app.core.security import hash_password, verify_password
from app.modules.invitations.repository import InvitationRepository, normalize_invitation_code
from app.modules.invitations.service import consume_invitation
from app.modules.users.domain import User, create_user
from app.modules.users.repository import UserRepository

# bcrypt only considers the first 72 bytes of a password; rejecting longer inputs
# avoids silently treating two different long passwords as identical.
MAX_PASSWORD_BYTES = 72

# Pre-generated bcrypt hash (of a throwaway password) used to equalize login timing:
# when the account does not exist we still run one bcrypt verification, so response
# time no longer reveals whether an email is registered.
DUMMY_PASSWORD_HASH = "$2b$12$I7FXaPt/gkzXMRAH2PfEXea5wkazBwtBZEixlc7T/SavgieLjSB4y"


def authenticate_user(email: str, password: str, user_repository: UserRepository) -> User | None:
    user = user_repository.get_by_email(email)
    if not user or user.status != "active":
        # Burn the same bcrypt cost as the happy path to avoid a user-enumeration
        # timing side channel.
        verify_password(password, DUMMY_PASSWORD_HASH)
        return None

    if not verify_password(password, user.password_hash):
        return None

    return user


def change_user_password(
    *,
    user: User,
    current_password: str,
    new_password: str,
    user_repository: UserRepository,
    commit: bool = True,
) -> User:
    if not verify_password(current_password, user.password_hash):
        raise ValueError("当前密码不正确")
    if len(new_password) < 8:
        raise ValueError("新密码至少需要 8 位")
    if len(new_password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        raise ValueError("新密码过长，请控制在 72 字节以内（约 24 个汉字或 72 个英文字符）")
    if verify_password(new_password, user.password_hash):
        raise ValueError("新密码不能与当前密码相同")

    updated_user = user_repository.update_fields(
        user.id, {"password_hash": hash_password(new_password), "updated_at": datetime.now(timezone.utc)}, commit=commit
    )
    if updated_user is None:
        raise ValueError("账号已不存在，请重新登录")
    return updated_user


def register_user_with_invitation(
    *,
    email: str,
    invitation_code: str,
    nickname: str,
    password: str,
    invitation_repository: InvitationRepository,
    user_repository: UserRepository,
) -> User:
    normalized_email = email.strip().lower()
    normalized_nickname = nickname.strip()
    if not normalized_email or "@" not in normalized_email:
        raise ValueError("请输入有效邮箱")
    if len(normalized_nickname) < 1:
        raise ValueError("请输入昵称")
    if len(password) < 8:
        raise ValueError("密码至少需要 8 位")
    if len(password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        raise ValueError("密码过长，请控制在 72 字节以内（约 24 个汉字或 72 个英文字符）")
    if user_repository.get_by_email(normalized_email):
        raise ValueError("这个邮箱已经注册")
    invitation = invitation_repository.get_by_code(normalize_invitation_code(invitation_code))
    if not invitation or invitation.status != "available":
        raise ValueError("邀请码无效或已被使用")

    try:
        user = user_repository.save(
            create_user(
                email=normalized_email,
                id=str(uuid4()),
                nickname=normalized_nickname,
                password_hash=hash_password(password),
            ),
            commit=False,
        )
        consume_invitation(invitation_code, user.id, invitation_repository, commit=False)
        user_repository.commit()
        invitation_repository.commit()
    except IntegrityError as error:
        # A concurrent registration can win the unique email/account-number race
        # between the pre-check above and our commit. Surface a 400 instead of a 500.
        user_repository.rollback()
        invitation_repository.rollback()
        if user_repository.get_by_email(normalized_email):
            raise ValueError("这个邮箱已经注册") from error
        raise ValueError("注册失败，请重试") from error
    except Exception:
        user_repository.rollback()
        invitation_repository.rollback()
        raise

    return user
