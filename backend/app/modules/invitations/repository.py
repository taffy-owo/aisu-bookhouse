from datetime import datetime, timezone
from typing import Protocol, cast

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.modules.invitations.domain import Invitation, InvitationStatus
from app.modules.invitations.models import InvitationRecord


class InvitationRepository(Protocol):
    def count_used_by_inviter(self, user_id: str) -> int:
        ...

    def get_by_code(self, code: str) -> Invitation | None:
        ...

    def get_latest_by_inviter(self, user_id: str) -> Invitation | None:
        ...

    def revoke_available_by_inviter(self, user_id: str, *, commit: bool = True) -> int:
        ...

    def save(self, invitation: Invitation, *, commit: bool = True) -> Invitation:
        ...

    def consume_available(self, code: str, invitee_user_id: str, *, commit: bool = True) -> Invitation | None:
        ...

    def commit(self) -> None:
        ...

    def rollback(self) -> None:
        ...


class InMemoryInvitationRepository:
    def __init__(self, invitations: list[Invitation] | None = None) -> None:
        self._invitations_by_id = {invitation.id: invitation for invitation in invitations or []}
        self._pending_by_id: dict[str, Invitation] = {}

    def count_used_by_inviter(self, user_id: str) -> int:
        return sum(1 for invitation in self._invitations_by_id.values() if invitation.inviter_user_id == user_id and invitation.status == "used")

    def get_by_code(self, code: str) -> Invitation | None:
        normalized_code = normalize_invitation_code(code)
        return next(
            (
                invitation
                for invitation in [*self._pending_by_id.values(), *self._invitations_by_id.values()]
                if invitation.code == normalized_code
            ),
            None,
        )

    def get_latest_by_inviter(self, user_id: str) -> Invitation | None:
        invitations = [invitation for invitation in self._invitations_by_id.values() if invitation.inviter_user_id == user_id]
        return max(invitations, key=lambda invitation: invitation.created_at) if invitations else None

    def revoke_available_by_inviter(self, user_id: str, *, commit: bool = True) -> int:
        now = datetime.now(timezone.utc)
        revoked_count = 0
        for invitation in list(self._invitations_by_id.values()):
            if invitation.inviter_user_id == user_id and invitation.status == "available":
                revoked_count += 1
                self.save(invitation.with_changes(status="revoked", updated_at=now), commit=commit)
        return revoked_count

    def save(self, invitation: Invitation, *, commit: bool = True) -> Invitation:
        if not commit:
            self._pending_by_id[invitation.id] = invitation
            return invitation

        self._invitations_by_id[invitation.id] = invitation
        return invitation

    def consume_available(self, code: str, invitee_user_id: str, *, commit: bool = True) -> Invitation | None:
        invitation = self.get_by_code(code)
        if not invitation or invitation.status != "available":
            return None

        consumed = invitation.with_changes(
            invitee_user_id=invitee_user_id,
            status="used",
            used_at=datetime.now(timezone.utc),
        )
        return self.save(consumed, commit=commit)

    def commit(self) -> None:
        self._invitations_by_id.update(self._pending_by_id)
        self._pending_by_id.clear()

    def rollback(self) -> None:
        self._pending_by_id.clear()


class SqlAlchemyInvitationRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def count_used_by_inviter(self, user_id: str) -> int:
        records = self._session.scalars(
            select(InvitationRecord.id).where(InvitationRecord.inviter_user_id == user_id, InvitationRecord.status == "used")
        ).all()
        return len(records)

    def get_by_code(self, code: str) -> Invitation | None:
        record = self._session.scalar(select(InvitationRecord).where(InvitationRecord.code == normalize_invitation_code(code)))
        return record_to_invitation(record) if record else None

    def get_latest_by_inviter(self, user_id: str) -> Invitation | None:
        record = self._session.scalar(
            select(InvitationRecord).where(InvitationRecord.inviter_user_id == user_id).order_by(InvitationRecord.created_at.desc())
        )
        return record_to_invitation(record) if record else None

    def revoke_available_by_inviter(self, user_id: str, *, commit: bool = True) -> int:
        now = datetime.now(timezone.utc)
        result = self._session.execute(
            update(InvitationRecord)
            .where(InvitationRecord.inviter_user_id == user_id, InvitationRecord.status == "available")
            .values(status="revoked", updated_at=now)
        )
        if commit:
            self._session.commit()
        else:
            self._session.flush()
        return int(result.rowcount or 0)

    def save(self, invitation: Invitation, *, commit: bool = True) -> Invitation:
        record = self._session.get(InvitationRecord, invitation.id)
        if record is None:
            record = invitation_to_record(invitation)
            self._session.add(record)
        else:
            update_invitation_record(record, invitation)

        if commit:
            self._session.commit()
            self._session.refresh(record)
        else:
            self._session.flush()
        return record_to_invitation(record)

    def consume_available(self, code: str, invitee_user_id: str, *, commit: bool = True) -> Invitation | None:
        now = datetime.now(timezone.utc)
        normalized_code = normalize_invitation_code(code)
        result = self._session.execute(
            update(InvitationRecord)
            .where(InvitationRecord.code == normalized_code, InvitationRecord.status == "available")
            .values(invitee_user_id=invitee_user_id, status="used", updated_at=now, used_at=now)
        )
        if result.rowcount != 1:
            return None

        if commit:
            self._session.commit()
        else:
            self._session.flush()

        record = self._session.scalar(select(InvitationRecord).where(InvitationRecord.code == normalized_code))
        return record_to_invitation(record) if record else None

    def commit(self) -> None:
        self._session.commit()

    def rollback(self) -> None:
        self._session.rollback()


def normalize_invitation_code(code: str) -> str:
    return code.strip().upper()


def invitation_to_record(invitation: Invitation) -> InvitationRecord:
    return InvitationRecord(
        id=invitation.id,
        code=invitation.code,
        inviter_user_id=invitation.inviter_user_id,
        invitee_user_id=invitation.invitee_user_id,
        status=invitation.status,
        created_at=invitation.created_at,
        updated_at=invitation.updated_at,
        used_at=invitation.used_at,
    )


def update_invitation_record(record: InvitationRecord, invitation: Invitation) -> None:
    record.code = invitation.code
    record.inviter_user_id = invitation.inviter_user_id
    record.invitee_user_id = invitation.invitee_user_id
    record.status = invitation.status
    record.created_at = invitation.created_at
    record.updated_at = invitation.updated_at
    record.used_at = invitation.used_at


def record_to_invitation(record: InvitationRecord) -> Invitation:
    return Invitation(
        id=record.id,
        code=record.code,
        inviter_user_id=record.inviter_user_id,
        invitee_user_id=record.invitee_user_id,
        status=cast(InvitationStatus, record.status),
        created_at=record.created_at,
        updated_at=record.updated_at,
        used_at=record.used_at,
    )
