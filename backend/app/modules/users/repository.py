from dataclasses import replace
from collections.abc import Mapping
from typing import Protocol, cast

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.modules.users.domain import User, UserRole, UserStatus, UserSummary
from app.modules.users.models import UserRecord


USER_UPDATE_FIELDS = frozenset({
    "password_hash", "nickname", "status", "avatar", "updated_at",
    "ai_provider_base_url", "ai_provider_api_key_encrypted", "ai_translation_model",
    "ai_translation_prompt", "ai_translation_concurrency", "audiobook_provider_base_url",
    "audiobook_provider_api_key_encrypted", "audiobook_tts_model", "audiobook_tts_voice",
})


def validate_user_changes(changes: Mapping[str, object]) -> None:
    unknown = changes.keys() - USER_UPDATE_FIELDS
    if unknown:
        raise ValueError("Unsupported user update fields: " + ", ".join(sorted(unknown)))


class UserRepository(Protocol):
    def list_all(self) -> list[User]:
        ...

    def list_summaries(self) -> list[UserSummary]:
        ...

    def list_by_ids(self, user_ids: list[str]) -> list[User]:
        ...

    def get_by_email(self, email: str) -> User | None:
        ...

    def get_by_id(self, user_id: str) -> User | None:
        ...

    def save(self, user: User, *, commit: bool = True) -> User:
        ...

    def update_fields(
        self,
        user_id: str,
        changes: Mapping[str, object],
        *,
        commit: bool = True,
        expected: Mapping[str, object] | None = None,
    ) -> User | None:
        ...

    def commit(self) -> None:
        ...

    def rollback(self) -> None:
        ...


class InMemoryUserRepository:
    def __init__(self, users: list[User] | None = None) -> None:
        self._users_by_id: dict[str, User] = {}
        self._users_by_email: dict[str, User] = {}
        self._pending_by_id: dict[str, User] = {}
        self._pending_by_email: dict[str, User] = {}
        seeded_users = list(users or [])
        for user in (item for item in seeded_users if item.account_number is not None):
            self.save(user)
        for user in (item for item in seeded_users if item.account_number is None):
            self.save(user)

    def list_all(self) -> list[User]:
        users_by_id = {**self._users_by_id, **self._pending_by_id}
        return sorted(users_by_id.values(), key=lambda user: user.account_number or 0)

    def list_summaries(self) -> list[UserSummary]:
        return [
            UserSummary(
                id=user.id, account_number=user.account_number, email=user.email,
                nickname=user.nickname, role=user.role, status=user.status,
                avatar=user.avatar, created_at=user.created_at, updated_at=user.updated_at,
            )
            for user in self.list_all()
        ]

    def list_by_ids(self, user_ids: list[str]) -> list[User]:
        requested_ids = set(user_ids)
        if not requested_ids:
            return []
        users_by_id = {**self._users_by_id, **self._pending_by_id}
        return sorted((user for user_id, user in users_by_id.items() if user_id in requested_ids), key=lambda user: user.account_number or 0)

    def get_by_email(self, email: str) -> User | None:
        normalized_email = email.lower()
        return self._pending_by_email.get(normalized_email) or self._users_by_email.get(normalized_email)

    def get_by_id(self, user_id: str) -> User | None:
        return self._pending_by_id.get(user_id) or self._users_by_id.get(user_id)

    def save(self, user: User, *, commit: bool = True) -> User:
        user = self._with_account_number(user)
        if not commit:
            self._pending_by_id[user.id] = user
            self._pending_by_email[user.email.lower()] = user
            return user

        self._users_by_id[user.id] = user
        self._users_by_email[user.email.lower()] = user
        return user

    def update_fields(
        self,
        user_id: str,
        changes: Mapping[str, object],
        *,
        commit: bool = True,
        expected: Mapping[str, object] | None = None,
    ) -> User | None:
        validate_user_changes(changes)
        if expected is not None:
            validate_user_changes(expected)
        user = self.get_by_id(user_id)
        if user is None or (expected and any(getattr(user, key) != value for key, value in expected.items())):
            return None
        if not changes:
            return user
        self.save(replace(user, **changes), commit=False)
        if commit:
            self.commit()
        return self.get_by_id(user_id)

    def commit(self) -> None:
        self._users_by_id.update(self._pending_by_id)
        self._users_by_email.update(self._pending_by_email)
        self._pending_by_id.clear()
        self._pending_by_email.clear()

    def rollback(self) -> None:
        self._pending_by_id.clear()
        self._pending_by_email.clear()

    def _with_account_number(self, user: User) -> User:
        if user.account_number is not None:
            return user

        used_numbers = [
            existing_user.account_number
            for existing_user in [*self._users_by_id.values(), *self._pending_by_id.values()]
            if existing_user.account_number is not None
        ]
        return replace(user, account_number=(max(used_numbers) if used_numbers else 0) + 1)


class SqlAlchemyUserRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def list_all(self) -> list[User]:
        records = self._session.scalars(select(UserRecord).order_by(UserRecord.account_number.asc(), UserRecord.created_at.asc())).all()
        return [record_to_user(record) for record in records]

    def list_summaries(self) -> list[UserSummary]:
        rows = self._session.execute(
            select(
                UserRecord.id, UserRecord.account_number, UserRecord.email,
                UserRecord.nickname, UserRecord.role, UserRecord.status,
                UserRecord.avatar, UserRecord.created_at, UserRecord.updated_at,
            ).order_by(UserRecord.account_number.asc(), UserRecord.created_at.asc())
        ).all()
        return [
            UserSummary(
                id=row.id, account_number=row.account_number, email=row.email,
                nickname=row.nickname, role=cast(UserRole, row.role), status=cast(UserStatus, row.status),
                avatar=row.avatar, created_at=row.created_at, updated_at=row.updated_at,
            )
            for row in rows
        ]

    def list_by_ids(self, user_ids: list[str]) -> list[User]:
        requested_ids = set(user_ids)
        if not requested_ids:
            return []
        records = self._session.scalars(
            select(UserRecord)
            .where(UserRecord.id.in_(requested_ids))
            .order_by(UserRecord.account_number.asc(), UserRecord.created_at.asc())
        ).all()
        return [record_to_user(record) for record in records]

    def get_by_email(self, email: str) -> User | None:
        record = self._session.scalar(select(UserRecord).where(UserRecord.email == email.lower()))
        return record_to_user(record) if record else None

    def get_by_id(self, user_id: str) -> User | None:
        record = self._session.get(UserRecord, user_id)
        return record_to_user(record) if record else None

    def save(self, user: User, *, commit: bool = True) -> User:
        record = self._session.get(UserRecord, user.id)
        if record is None:
            user = self._with_account_number(user)
            record = user_to_record(user)
            self._session.add(record)
        else:
            if user.account_number is None:
                user = replace(user, account_number=record.account_number or self._next_account_number())
            update_user_record(record, user)

        if commit:
            self._session.commit()
            self._session.refresh(record)
        else:
            self._session.flush()
        return record_to_user(record)

    def update_fields(
        self,
        user_id: str,
        changes: Mapping[str, object],
        *,
        commit: bool = True,
        expected: Mapping[str, object] | None = None,
    ) -> User | None:
        validate_user_changes(changes)
        if expected is not None:
            validate_user_changes(expected)
        if not changes:
            return self.get_by_id(user_id)
        predicates = [UserRecord.id == user_id]
        if expected:
            predicates.extend(
                getattr(UserRecord, key).is_(value) if value is None else getattr(UserRecord, key) == value
                for key, value in expected.items()
            )
        result = self._session.execute(
            update(UserRecord).where(*predicates).values(**changes)
            .execution_options(synchronize_session="fetch")
        )
        if result.rowcount == 0:
            return None
        if commit:
            self._session.commit()
        else:
            self._session.flush()
        record = self._session.scalar(
            select(UserRecord).where(UserRecord.id == user_id).execution_options(populate_existing=True)
        )
        return record_to_user(record) if record else None

    def commit(self) -> None:
        self._session.commit()

    def rollback(self) -> None:
        self._session.rollback()

    def _next_account_number(self) -> int:
        current_max = self._session.scalar(select(func.max(UserRecord.account_number)))
        return (current_max or 0) + 1

    def _with_account_number(self, user: User) -> User:
        if user.account_number is not None:
            return user
        return replace(user, account_number=self._next_account_number())


def user_to_record(user: User) -> UserRecord:
    return UserRecord(
        id=user.id,
        account_number=user.account_number,
        email=user.email.lower(),
        password_hash=user.password_hash,
        nickname=user.nickname,
        role=user.role,
        status=user.status,
        avatar=user.avatar,
        ai_provider_base_url=user.ai_provider_base_url,
        ai_provider_api_key_encrypted=user.ai_provider_api_key_encrypted,
        ai_translation_model=user.ai_translation_model,
        ai_translation_prompt=user.ai_translation_prompt,
        ai_translation_concurrency=user.ai_translation_concurrency,
        audiobook_provider_base_url=user.audiobook_provider_base_url,
        audiobook_provider_api_key_encrypted=user.audiobook_provider_api_key_encrypted,
        audiobook_tts_model=user.audiobook_tts_model,
        audiobook_tts_voice=user.audiobook_tts_voice,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )


def update_user_record(record: UserRecord, user: User) -> None:
    if user.account_number is not None:
        record.account_number = user.account_number
    record.email = user.email.lower()
    record.password_hash = user.password_hash
    record.nickname = user.nickname
    record.role = user.role
    record.status = user.status
    record.avatar = user.avatar
    record.ai_provider_base_url = user.ai_provider_base_url
    record.ai_provider_api_key_encrypted = user.ai_provider_api_key_encrypted
    record.ai_translation_model = user.ai_translation_model
    record.ai_translation_prompt = user.ai_translation_prompt
    record.ai_translation_concurrency = user.ai_translation_concurrency
    record.audiobook_provider_base_url = user.audiobook_provider_base_url
    record.audiobook_provider_api_key_encrypted = user.audiobook_provider_api_key_encrypted
    record.audiobook_tts_model = user.audiobook_tts_model
    record.audiobook_tts_voice = user.audiobook_tts_voice
    record.created_at = user.created_at
    record.updated_at = user.updated_at


def record_to_user(record: UserRecord) -> User:
    return User(
        id=record.id,
        account_number=record.account_number,
        email=record.email,
        password_hash=record.password_hash,
        nickname=record.nickname,
        role=cast(UserRole, record.role),
        status=cast(UserStatus, record.status),
        avatar=record.avatar,
        ai_provider_base_url=record.ai_provider_base_url,
        ai_provider_api_key_encrypted=record.ai_provider_api_key_encrypted,
        ai_translation_model=record.ai_translation_model,
        ai_translation_prompt=record.ai_translation_prompt,
        ai_translation_concurrency=record.ai_translation_concurrency,
        audiobook_provider_base_url=record.audiobook_provider_base_url,
        audiobook_provider_api_key_encrypted=record.audiobook_provider_api_key_encrypted,
        audiobook_tts_model=record.audiobook_tts_model,
        audiobook_tts_voice=record.audiobook_tts_voice,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def record_to_user_summary(record: UserRecord) -> UserSummary:
    return UserSummary(
        id=record.id,
        account_number=record.account_number,
        email=record.email,
        nickname=record.nickname,
        role=cast(UserRole, record.role),
        status=cast(UserStatus, record.status),
        avatar=record.avatar,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


