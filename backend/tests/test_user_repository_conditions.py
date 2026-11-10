from app.modules.users.domain import create_user
from app.modules.users.repository import InMemoryUserRepository, SqlAlchemyUserRepository


def test_sqlalchemy_update_fields_honors_expected_snapshot(client) -> None:
    user = create_user(
        id="sql-user",
        account_number=None,
        email="sql-user@example.com",
        nickname="SQL User",
        password_hash="hash",
    )
    with client.app.state.db_session_factory() as session:
        repository = SqlAlchemyUserRepository(session)
        repository.save(user)
        assert repository.update_fields("sql-user", {"avatar": "new.webp"}, expected={"avatar": "stale.webp"}) is None
        updated = repository.update_fields("sql-user", {"avatar": "new.webp"}, expected={"avatar": None})
        assert updated is not None
        assert updated.avatar == "new.webp"


def test_in_memory_seed_assigns_missing_account_numbers() -> None:
    repository = InMemoryUserRepository([
        create_user(id="first", account_number=None, email="first@example.com", nickname="First", password_hash="hash"),
        create_user(id="fixed", account_number=7, email="fixed@example.com", nickname="Fixed", password_hash="hash"),
    ])

    assert repository.get_by_id("first").account_number == 8
    assert repository.get_by_id("fixed").account_number == 7


def test_in_memory_update_fields_honors_expected_snapshot() -> None:
    repository = InMemoryUserRepository([
        create_user(id="user", account_number=1, email="user@example.com", nickname="User", password_hash="hash"),
    ])

    assert repository.update_fields("user", {"avatar": "new.webp"}, expected={"avatar": "stale.webp"}) is None
    assert repository.get_by_id("user").avatar is None

    updated = repository.update_fields("user", {"avatar": "new.webp"}, expected={"avatar": None})
    assert updated is not None
    assert updated.avatar == "new.webp"
