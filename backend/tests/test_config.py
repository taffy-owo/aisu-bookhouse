import pytest

from app.core.config import Settings, get_settings, parse_cors_origins, validate_production_settings
from app.main import create_app
from app.modules.uploads.worker import process_next_upload_task


def production_settings(**overrides) -> Settings:
    values = {
        "environment": "production",
        "jwt_secret": "x" * 32,
        "encryption_key": "y" * 32,
        "ai_translation_global_daily_call_budget": 4000,
        "default_admin_password": "changed-password-123",
        "auto_create_tables": False,
        "seed_demo_data": False,
        "cors_origins": ("https://aisu.example.com",),
        "cors_origins_explicit": True,
        "database_url": "sqlite+pysqlite:///:memory:",
        "storage_root": "/tmp/aisu-test-storage",
    }
    values.update(overrides)
    return Settings(**values)


def test_parse_cors_origins_strips_whitespace_and_slashes() -> None:
    assert parse_cors_origins(" https://a.example.com/ ,https://b.example.com ") == ("https://a.example.com", "https://b.example.com")


def test_scheduled_backup_settings_read_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv("AISU_SCHEDULED_BACKUP_PREFIX", "auto")
    monkeypatch.setenv("AISU_SCHEDULED_BACKUP_KEEP_COUNT", "2")
    monkeypatch.setenv("AISU_SCHEDULED_BACKUP_KEEP_DAYS", "")

    try:
        settings = get_settings()
    finally:
        get_settings.cache_clear()

    assert settings.scheduled_backup_prefix == "auto"
    assert settings.scheduled_backup_keep_count == 2
    assert settings.scheduled_backup_keep_days is None


def test_jwt_expiry_reads_positive_environment_minutes(monkeypatch: pytest.MonkeyPatch) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv("AISU_JWT_EXPIRE_MINUTES", "43200")

    try:
        settings = get_settings()
    finally:
        get_settings.cache_clear()

    assert settings.jwt_expire_minutes == 43200


@pytest.mark.parametrize(
    ("name", "value"),
    [("AISU_ENV", "prod"), ("AISU_UPLOAD_PROCESSING_MODE", "backgroundd")],
)
def test_invalid_environment_mode_fails_instead_of_falling_back(
    monkeypatch: pytest.MonkeyPatch, name: str, value: str
) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match=name):
        get_settings()
    get_settings.cache_clear()


@pytest.mark.parametrize("value", ["0", "-1"])
def test_jwt_expiry_rejects_non_positive_minutes(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv("AISU_JWT_EXPIRE_MINUTES", value)
    with pytest.raises(ValueError, match="greater than 0"):
        get_settings()
    get_settings.cache_clear()


@pytest.mark.parametrize(
    ("name", "value", "expected"),
    [
        ("AISU_SCHEDULED_BACKUP_PREFIX", " ", "must not be empty"),
        ("AISU_SCHEDULED_BACKUP_PREFIX", "../auto", "must not contain path separators"),
        ("AISU_SCHEDULED_BACKUP_KEEP_COUNT", "-1", "greater than or equal to 0"),
        ("AISU_SCHEDULED_BACKUP_KEEP_DAYS", "-1", "greater than or equal to 0"),
    ],
)
def test_scheduled_backup_settings_reject_invalid_environment(monkeypatch: pytest.MonkeyPatch, name: str, value: str, expected: str) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match=expected):
        get_settings()
    get_settings.cache_clear()


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"jwt_secret": Settings.jwt_secret}, "AISU_JWT_SECRET"),
        ({"jwt_secret": "short"}, "AISU_JWT_SECRET"),
        ({"encryption_key": ""}, "AISU_ENCRYPTION_KEY"),
        ({"ai_translation_global_daily_call_budget": 0}, "AISU_AI_TRANSLATION_GLOBAL_DAILY_CALL_BUDGET"),
        ({"default_admin_password": Settings.default_admin_password}, "AISU_DEFAULT_ADMIN_PASSWORD"),
        ({"auto_create_tables": True}, "AISU_AUTO_CREATE_TABLES"),
        ({"seed_demo_data": True}, "AISU_SEED_DEMO_DATA"),
        ({"cors_origins_explicit": False}, "AISU_CORS_ORIGINS"),
        ({"cors_origins": ()}, "AISU_CORS_ORIGINS"),
        ({"cors_origins": ("*",)}, "must not contain *"),
        ({"cors_origins": ("http://aisu.example.com",)}, "https origins"),
        ({"ai_translation_api_key": "secret", "ai_translation_base_url": "http://ai.example.com/v1"}, "https URL"),
        ({"ai_translation_api_key": "secret", "ai_translation_base_url": "https://ai.example.com/v1"}, "AISU_AI_ALLOWED_BASE_HOSTS"),
    ],
)
def test_production_settings_fail_fast(overrides: dict[str, object], expected: str) -> None:
    with pytest.raises(RuntimeError, match=expected):
        validate_production_settings(production_settings(**overrides))


def test_safe_production_settings_pass() -> None:
    validate_production_settings(production_settings())


def test_safe_production_ai_translation_settings_pass() -> None:
    validate_production_settings(production_settings(
        ai_allowed_base_hosts=("ai.example.com",),
        ai_translation_api_key="secret",
        ai_translation_base_url="https://ai.example.com/v1",
    ))


def test_production_background_processing_mode_warns_but_does_not_fail(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level("WARNING", logger="app.core.config"):
        validate_production_settings(production_settings(upload_processing_mode="background"))

    assert any("AISU_UPLOAD_PROCESSING_MODE" in record.message for record in caplog.records)


def test_production_external_processing_mode_does_not_warn(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level("WARNING", logger="app.core.config"):
        validate_production_settings(production_settings(upload_processing_mode="external"))

    assert not any("AISU_UPLOAD_PROCESSING_MODE" in record.message for record in caplog.records)


def test_create_app_runs_production_validation() -> None:
    with pytest.raises(RuntimeError, match="Unsafe production configuration"):
        create_app(production_settings(jwt_secret=Settings.jwt_secret))


def test_worker_runs_same_production_validation() -> None:
    with pytest.raises(RuntimeError, match="AISU_AI_TRANSLATION_GLOBAL_DAILY_CALL_BUDGET"):
        process_next_upload_task(settings=production_settings(ai_translation_global_daily_call_budget=0))
