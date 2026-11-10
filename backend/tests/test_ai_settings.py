import pytest
import asyncio
from dataclasses import replace
from datetime import datetime, timezone

from app.core.database import create_database_engine, create_database_schema, create_session_factory

from app.core.config import Settings
from app.modules.users.ai_settings import (
    apply_user_ai_models,
    apply_user_audiobook_settings,
    decrypt_ai_api_key,
    encrypt_ai_api_key,
    normalize_ai_provider_base_url,
    parse_provider_ai_models,
)
from app.modules.users.domain import create_user
from app.modules.users.credential_rotation import rotate_stored_credentials
from app.modules.users.credential_rotation import inspect_stored_credentials
from app.modules.ai_channels.models import AiChannelModelRecord, AiChannelRecord
from app.modules.ai_channels.service import probe_channel_models
from app.modules.translations.models import WholeBookTranslationJobRecord
from app.modules.uploads.source_metadata_settings import metadata_translation_settings
from app.modules.users.models import UserRecord
from app.modules.users.repository import record_to_user, user_to_record


def test_applies_encrypted_user_provider_without_exposing_credentials() -> None:
    settings = Settings(
        jwt_secret="test-secret-long-enough-for-credential-encryption",
        ai_translation_api_key="server-secret",
        ai_translation_base_url="https://server.example/v1",
        ai_translation_model="server-text",
        audiobook_tts_model="server-tts",
    )
    encrypted_key = encrypt_ai_api_key("reader-secret", settings)
    user = create_user(
        id="reader",
        email="reader@example.com",
        nickname="Reader",
        password_hash="hash",
        ai_provider_base_url="https://reader.example/v1",
        ai_provider_api_key_encrypted=encrypted_key,
        ai_translation_model="reader-text",
        audiobook_provider_base_url="https://speech.example/v1",
        audiobook_provider_api_key_encrypted=encrypted_key,
        audiobook_tts_model="reader-tts",
        audiobook_tts_voice="alloy",
    )

    effective = apply_user_ai_models(settings, user)

    assert effective.ai_translation_base_url == "https://reader.example/v1"
    assert effective.ai_translation_api_key == "reader-secret"
    assert effective.ai_translation_model == "reader-text"
    assert effective.audiobook_tts_model == "server-tts"
    assert settings.ai_translation_api_key == "server-secret"
    assert encrypted_key != "reader-secret"
    assert decrypt_ai_api_key(encrypted_key, settings) == "reader-secret"

    audiobook_settings = apply_user_audiobook_settings(settings, user)
    assert audiobook_settings.ai_translation_base_url == "https://speech.example/v1"
    assert audiobook_settings.ai_translation_api_key == "reader-secret"
    assert audiobook_settings.audiobook_tts_model == "reader-tts"
    assert audiobook_settings.audiobook_tts_voice == "alloy"


def test_ignores_legacy_model_only_preferences_without_user_credentials() -> None:
    settings = Settings(
        ai_translation_api_key="server-secret",
        ai_translation_base_url="https://server.example/v1",
        ai_translation_model="server-text",
    )
    user = create_user(
        id="reader",
        email="reader@example.com",
        nickname="Reader",
        password_hash="hash",
        ai_translation_model="legacy-model-only-choice",
    )

    effective = apply_user_ai_models(settings, user)

    assert effective.ai_translation_base_url == "https://server.example/v1"
    assert effective.ai_translation_model == "server-text"


def test_user_provider_does_not_fall_back_to_server_models() -> None:
    settings = Settings(
        jwt_secret="test-secret-long-enough-for-credential-encryption",
        ai_translation_model="obsolete-server-text",
        audiobook_tts_model="obsolete-server-tts",
    )
    user = create_user(
        id="reader",
        email="reader@example.com",
        nickname="Reader",
        password_hash="hash",
        ai_provider_base_url="https://reader.example/v1",
        ai_provider_api_key_encrypted=encrypt_ai_api_key("reader-secret", settings),
    )

    effective = apply_user_ai_models(settings, user)

    assert effective.ai_translation_model == ""
    assert effective.audiobook_tts_model == "obsolete-server-tts"


@pytest.mark.parametrize("url", ["http://api.example.com/v1", "https://localhost/v1", "https://127.0.0.1/v1"])
def test_rejects_unsafe_ai_provider_urls(url: str) -> None:
    with pytest.raises(ValueError):
        normalize_ai_provider_base_url(url)


def test_normalizes_ai_provider_url() -> None:
    assert normalize_ai_provider_base_url(" https://API.Example.com/v1/ ") == "https://api.example.com/v1"


def test_parses_deduplicated_provider_models() -> None:
    assert parse_provider_ai_models(
        {"data": [{"id": "mimo-v2.5-pro"}, {"id": "mimo-v2.5-tts"}, {"id": "mimo-v2.5-pro"}, {"name": "ignored"}]}
    ) == ["mimo-v2.5-pro", "mimo-v2.5-tts"]


def test_credential_rotation_is_atomic_and_survives_jwt_rotation(tmp_path) -> None:
    old_secret = "old-jwt-secret-" + "x" * 32
    new_secret = "separate-credential-secret-" + "y" * 32
    settings = Settings(
        jwt_secret=old_secret,
        database_url=f"sqlite+pysqlite:///{(tmp_path / 'users.db').as_posix()}",
        storage_root=str(tmp_path / "storage"),
    )
    engine = create_database_engine(settings)
    create_database_schema(engine)
    original = encrypt_ai_api_key("saved-secret", settings)
    with create_session_factory(engine)() as session:
        session.add(user_to_record(create_user(
            id="reader", email="reader@example.com", nickname="Reader", password_hash="hash",
            account_number=1, ai_provider_api_key_encrypted=original,
            audiobook_provider_api_key_encrypted=original,
        )))
        session.commit()
    engine.dispose()

    with pytest.raises(ValueError, match="no credentials were changed"):
        rotate_stored_credentials(old_secret="wrong-" + "z" * 32, new_secret=new_secret, settings=settings)
    engine = create_database_engine(settings)
    with create_session_factory(engine)() as session:
        assert session.get(UserRecord, "reader").ai_provider_api_key_encrypted == original
    engine.dispose()

    assert rotate_stored_credentials(old_secret=old_secret, new_secret=new_secret, settings=settings) == 2
    rotated_settings = replace(settings, jwt_secret="rotated-jwt-" + "z" * 32, encryption_key=new_secret)
    engine = create_database_engine(settings)
    with create_session_factory(engine)() as session:
        record = session.get(UserRecord, "reader")
        assert decrypt_ai_api_key(record.ai_provider_api_key_encrypted, rotated_settings) == "saved-secret"
        assert decrypt_ai_api_key(record.audiobook_provider_api_key_encrypted, rotated_settings) == "saved-secret"
    engine.dispose()


def test_rotation_covers_channels_and_job_snapshots_with_atomic_preflight(tmp_path, monkeypatch) -> None:
    old_secret = "old-jwt-secret-" + "x" * 32
    new_secret = "new-provider-secret-" + "y" * 32
    settings = Settings(
        jwt_secret=old_secret,
        database_url=f"sqlite+pysqlite:///{(tmp_path / 'credentials.db').as_posix()}",
        storage_root=str(tmp_path / "storage"),
    )
    engine = create_database_engine(settings)
    create_database_schema(engine)
    now = datetime.now(timezone.utc)
    encrypted = {name: encrypt_ai_api_key(name, settings) for name in ("user-key", "audio-key", "active-key", "inactive-key", "job-key")}
    with create_session_factory(engine)() as session:
        session.add(user_to_record(create_user(
            id="reader", email="reader@example.com", nickname="Reader", password_hash="hash",
            account_number=1, ai_provider_base_url="https://user.example/v1",
            ai_provider_api_key_encrypted=encrypted["user-key"],
            audiobook_provider_api_key_encrypted=encrypted["audio-key"],
        )))
        session.flush()
        for channel_id, name, enabled in (("active", "active-key", True), ("inactive", "inactive-key", False)):
            session.add(AiChannelRecord(
                id=channel_id, user_id="reader", name=channel_id,
                base_url="https://example.com/v1", api_key_encrypted=encrypted[name],
                enabled=enabled, sort_order=0 if enabled else 1, created_at=now, updated_at=now,
            ))
        session.flush()
        session.add(AiChannelModelRecord(
            id="model", channel_id="active", model="gemini-3-flash", enabled=True,
            created_at=now, updated_at=now,
        ))
        session.add(WholeBookTranslationJobRecord(
            id="job", user_id="reader", source_url="https://example.com/book",
            source_provider="test", title="Book", author="Author", status="queued", stage="queued",
            model="test-model", provider_base_url="https://example.com/v1",
            provider_api_key_encrypted=encrypted["job-key"], created_at=now, updated_at=now,
        ))
        session.commit()
    engine.dispose()

    report = inspect_stored_credentials(old_secret=old_secret, settings=settings)
    assert report["users"] == {"pending": 2, "verified": 2, "failures": []}
    assert report["ai_channels"] == {"pending": 2, "verified": 2, "failures": []}
    assert report["whole_book_translation_jobs"] == {"pending": 1, "verified": 1, "failures": []}

    engine = create_database_engine(settings)
    with create_session_factory(engine)() as session:
        broken = session.get(AiChannelRecord, "inactive")
        broken.api_key_encrypted = "corrupt"
        session.commit()
    engine.dispose()
    report = inspect_stored_credentials(old_secret=old_secret, settings=settings)
    assert report["ai_channels"]["failures"] == ["inactive:api_key_encrypted"]
    with pytest.raises(ValueError, match="no credentials were changed"):
        rotate_stored_credentials(old_secret=old_secret, new_secret=new_secret, settings=settings)
    engine = create_database_engine(settings)
    with create_session_factory(engine)() as session:
        assert session.get(UserRecord, "reader").ai_provider_api_key_encrypted == encrypted["user-key"]
        assert session.get(AiChannelRecord, "active").api_key_encrypted == encrypted["active-key"]
        assert session.get(WholeBookTranslationJobRecord, "job").provider_api_key_encrypted == encrypted["job-key"]
        session.get(AiChannelRecord, "inactive").api_key_encrypted = encrypted["inactive-key"]
        session.commit()
    engine.dispose()

    assert rotate_stored_credentials(old_secret=old_secret, new_secret=new_secret, settings=settings) == 5
    rotated_settings = replace(settings, jwt_secret="changed-jwt-" + "z" * 32, encryption_key=new_secret)
    seen: list[str] = []
    async def fake_fetch_models(probe_settings):
        seen.append(probe_settings.ai_translation_api_key)
        return ["gemini-3-flash"]
    monkeypatch.setattr("app.modules.ai_channels.service.fetch_provider_ai_models", fake_fetch_models)
    engine = create_database_engine(settings)
    with create_session_factory(engine)() as session:
        user = record_to_user(session.get(UserRecord, "reader"))
        effective, channel_name = metadata_translation_settings(rotated_settings, user, session)
        assert channel_name == "active" and effective.ai_translation_api_key == "active-key"
        for channel_id in ("active", "inactive"):
            assert asyncio.run(probe_channel_models(
                user_id="reader", channel_id=channel_id, session=session, settings=rotated_settings
            )) == ["gemini-3-flash"]
        assert decrypt_ai_api_key(session.get(WholeBookTranslationJobRecord, "job").provider_api_key_encrypted, rotated_settings) == "job-key"
    engine.dispose()
    assert seen == ["active-key", "inactive-key"]
