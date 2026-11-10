from dataclasses import dataclass
from functools import lru_cache
import logging
import os
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


DEFAULT_JWT_SECRET = "dev-only-change-me-please-use-env-in-production"
DEFAULT_ADMIN_PASSWORD = "aisu-demo-password"
DEFAULT_CORS_ORIGINS = (
    "http://127.0.0.1:5177",
    "http://localhost:5177",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
)


@dataclass(frozen=True)
class Settings:
    product_name: str = "爱素书屋 API"
    api_prefix: str = "/api/v1"
    environment: str = "development"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24
    jwt_refresh_expire_days: int = 30
    jwt_secret: str = DEFAULT_JWT_SECRET
    encryption_key: str = ""
    database_url: str = "sqlite+pysqlite:///./aisu-bookhouse-dev.db"
    storage_root: str = "./data"
    flaresolverr_url: str = ""
    max_upload_size_bytes: int = 200 * 1024 * 1024
    max_archive_entries: int = 5000
    max_archive_member_size_bytes: int = 200 * 1024 * 1024
    max_backup_restore_size_bytes: int = 2 * 1024 * 1024 * 1024
    max_backup_restore_extracted_size_bytes: int = 8 * 1024 * 1024 * 1024
    max_processed_assets_per_book: int = 2000
    max_processed_size_bytes: int = 500 * 1024 * 1024
    scheduled_backup_prefix: str = "scheduled"
    scheduled_backup_keep_count: int = 5
    scheduled_backup_keep_days: int | None = 7
    auto_create_tables: bool = True
    bootstrap_admin: bool = True
    seed_demo_data: bool = False
    upload_processing_mode: str = "background"
    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS
    cors_origins_explicit: bool = False
    ai_allowed_base_hosts: tuple[str, ...] = ()
    ai_translation_api_key: str = ""
    ai_platform_builtin_api_key: str = ""
    ai_translation_base_url: str = ""
    ai_translation_model: str = ""
    ai_translation_secondary_model: str = ""
    # Third-line rescue lane after the preferred High model and the larger-quota
    # secondary Flash High lane. It also handles a chunk that both Flash models cannot
    # finish without re-asking the same poisoned request indefinitely.
    ai_translation_rescue_model: str = ""
    # 0 disables the client-side cap and leaves pacing to the gateway.
    ai_translation_daily_call_budget: int = 0
    ai_translation_global_daily_call_budget: int = 0
    ai_platform_credential_sha256: tuple[str, ...] = ()
    ai_translation_secondary_daily_call_budget: int = 0
    ai_translation_rescue_daily_call_budget: int = 0
    # Per-job tuning resolved from the channel's model row, so the translation
    # pipeline never has to recognize model names.
    ai_translation_max_concurrency: int = 4
    ai_translation_chunk_characters: int = 4500
    ai_translation_chunk_paragraphs: int = 220
    translation_engine: str = "legacy"
    translation_v2_chapter_request_limit: int = 24
    translation_v2_aux_request_limit: int = 12
    translation_auto_updates_enabled: bool = True
    translation_java: str = ""
    translation_epubcheck_jar: str = ""
    audiobook_tts_model: str = ""
    audiobook_tts_voice: str = "Chloe"
    default_user_id: str = "11111111-1111-4111-8111-111111111111"
    default_admin_email: str = "admin@aisu.local"
    default_admin_password: str = DEFAULT_ADMIN_PASSWORD
    oauth_frontend_redirect_uri: str = "http://localhost:5177/login"
    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""
    google_oauth_redirect_uri: str = "http://localhost:8000/api/v1/auth/oauth/google/callback"
    discord_oauth_client_id: str = ""
    discord_oauth_client_secret: str = ""
    discord_oauth_redirect_uri: str = "http://localhost:8000/api/v1/auth/oauth/discord/callback"


def parse_env_flag(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def parse_non_empty_text_env(name: str, default: str) -> str:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{name} must not be empty")
    if "/" in normalized or "\\" in normalized:
        raise ValueError(f"{name} must not contain path separators")
    return normalized


def parse_non_negative_int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    parsed = int(value.strip())
    if parsed < 0:
        raise ValueError(f"{name} must be greater than or equal to 0")
    return parsed


def parse_positive_int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    parsed = int(value.strip())
    if parsed <= 0:
        raise ValueError(f"{name} must be greater than 0")
    return parsed


def parse_optional_non_negative_int_env(name: str, default: int | None) -> int | None:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip()
    if not normalized:
        return None
    parsed = int(normalized)
    if parsed < 0:
        raise ValueError(f"{name} must be greater than or equal to 0")
    return parsed


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    cors_env = os.getenv("AISU_CORS_ORIGINS")
    return Settings(
        translation_engine=os.getenv("AISU_TRANSLATION_ENGINE", "legacy"),
        translation_v2_chapter_request_limit=parse_positive_int_env("AISU_V2_CHAPTER_REQUEST_LIMIT", 24),
        translation_v2_aux_request_limit=parse_positive_int_env("AISU_V2_AUX_REQUEST_LIMIT", 12),
        translation_auto_updates_enabled=parse_env_flag("AISU_TRANSLATION_AUTO_UPDATES_ENABLED", True),
        translation_java=os.getenv("AISU_TRANSLATION_JAVA", ""),
        translation_epubcheck_jar=os.getenv("AISU_TRANSLATION_EPUBCHECK_JAR", ""),
        environment=parse_environment(os.getenv("AISU_ENV", Settings.environment)),
        jwt_expire_minutes=parse_positive_int_env("AISU_JWT_EXPIRE_MINUTES", Settings.jwt_expire_minutes),
        jwt_refresh_expire_days=parse_positive_int_env("AISU_JWT_REFRESH_EXPIRE_DAYS", Settings.jwt_refresh_expire_days),
        jwt_secret=os.getenv("AISU_JWT_SECRET", Settings.jwt_secret),
        encryption_key=os.getenv("AISU_ENCRYPTION_KEY", Settings.encryption_key),
        database_url=os.getenv("AISU_DATABASE_URL", Settings.database_url),
        storage_root=os.getenv("AISU_STORAGE_ROOT", Settings.storage_root),
        flaresolverr_url=os.getenv("AISU_FLARESOLVERR_URL", "").strip().rstrip("/"),
        max_upload_size_bytes=int(os.getenv("AISU_MAX_UPLOAD_SIZE_BYTES", Settings.max_upload_size_bytes)),
        max_archive_entries=int(os.getenv("AISU_MAX_ARCHIVE_ENTRIES", Settings.max_archive_entries)),
        max_archive_member_size_bytes=int(os.getenv("AISU_MAX_ARCHIVE_MEMBER_SIZE_BYTES", Settings.max_archive_member_size_bytes)),
        max_backup_restore_size_bytes=int(os.getenv("AISU_MAX_BACKUP_RESTORE_SIZE_BYTES", Settings.max_backup_restore_size_bytes)),
        max_backup_restore_extracted_size_bytes=int(os.getenv("AISU_MAX_BACKUP_RESTORE_EXTRACTED_SIZE_BYTES", Settings.max_backup_restore_extracted_size_bytes)),
        max_processed_assets_per_book=int(os.getenv("AISU_MAX_PROCESSED_ASSETS_PER_BOOK", Settings.max_processed_assets_per_book)),
        max_processed_size_bytes=int(os.getenv("AISU_MAX_PROCESSED_SIZE_BYTES", Settings.max_processed_size_bytes)),
        scheduled_backup_prefix=parse_non_empty_text_env("AISU_SCHEDULED_BACKUP_PREFIX", Settings.scheduled_backup_prefix),
        scheduled_backup_keep_count=parse_non_negative_int_env("AISU_SCHEDULED_BACKUP_KEEP_COUNT", Settings.scheduled_backup_keep_count),
        scheduled_backup_keep_days=parse_optional_non_negative_int_env("AISU_SCHEDULED_BACKUP_KEEP_DAYS", Settings.scheduled_backup_keep_days),
        auto_create_tables=parse_env_flag("AISU_AUTO_CREATE_TABLES", Settings.auto_create_tables),
        bootstrap_admin=parse_env_flag("AISU_BOOTSTRAP_ADMIN", Settings.bootstrap_admin),
        seed_demo_data=parse_env_flag("AISU_SEED_DEMO_DATA", Settings.seed_demo_data),
        upload_processing_mode=parse_upload_processing_mode(os.getenv("AISU_UPLOAD_PROCESSING_MODE", Settings.upload_processing_mode)),
        cors_origins=parse_cors_origins(cors_env) if cors_env is not None else Settings.cors_origins,
        cors_origins_explicit=cors_env is not None,
        ai_allowed_base_hosts=parse_csv_tuple(os.getenv("AISU_AI_ALLOWED_BASE_HOSTS", "")),
        ai_translation_api_key=os.getenv("AISU_AI_TRANSLATION_API_KEY", "").strip(),
        ai_platform_builtin_api_key=os.getenv("AISU_AI_TRANSLATION_API_KEY", "").strip(),
        ai_translation_base_url=os.getenv("AISU_AI_TRANSLATION_BASE_URL", "").strip().rstrip("/"),
        ai_translation_model=parse_non_empty_text_env("AISU_AI_TRANSLATION_MODEL", Settings.ai_translation_model),
        ai_translation_secondary_model=parse_non_empty_text_env(
            "AISU_AI_TRANSLATION_SECONDARY_MODEL", Settings.ai_translation_secondary_model
        ),
        ai_translation_rescue_model=parse_non_empty_text_env(
            "AISU_AI_TRANSLATION_RESCUE_MODEL", Settings.ai_translation_rescue_model
        ),
        ai_translation_daily_call_budget=parse_non_negative_int_env(
            "AISU_AI_TRANSLATION_DAILY_CALL_BUDGET", Settings.ai_translation_daily_call_budget
        ),
        ai_translation_global_daily_call_budget=parse_non_negative_int_env(
            "AISU_AI_TRANSLATION_GLOBAL_DAILY_CALL_BUDGET", Settings.ai_translation_global_daily_call_budget
        ),
        ai_platform_credential_sha256=parse_csv_tuple(os.getenv("AISU_AI_PLATFORM_CREDENTIAL_SHA256", "")),
        ai_translation_secondary_daily_call_budget=parse_non_negative_int_env(
            "AISU_AI_TRANSLATION_SECONDARY_DAILY_CALL_BUDGET",
            Settings.ai_translation_secondary_daily_call_budget,
        ),
        ai_translation_rescue_daily_call_budget=parse_non_negative_int_env(
            "AISU_AI_TRANSLATION_RESCUE_DAILY_CALL_BUDGET", Settings.ai_translation_rescue_daily_call_budget
        ),
        audiobook_tts_model=parse_non_empty_text_env("AISU_AUDIOBOOK_TTS_MODEL", Settings.audiobook_tts_model),
        audiobook_tts_voice=parse_non_empty_text_env("AISU_AUDIOBOOK_TTS_VOICE", Settings.audiobook_tts_voice),
        default_admin_email=os.getenv("AISU_DEFAULT_ADMIN_EMAIL", Settings.default_admin_email),
        default_admin_password=os.getenv("AISU_DEFAULT_ADMIN_PASSWORD", Settings.default_admin_password),
        oauth_frontend_redirect_uri=os.getenv(
            "AISU_OAUTH_FRONTEND_REDIRECT_URI", Settings.oauth_frontend_redirect_uri
        ).strip(),
        google_oauth_client_id=os.getenv("AISU_GOOGLE_OAUTH_CLIENT_ID", "").strip(),
        google_oauth_client_secret=os.getenv("AISU_GOOGLE_OAUTH_CLIENT_SECRET", "").strip(),
        google_oauth_redirect_uri=os.getenv(
            "AISU_GOOGLE_OAUTH_REDIRECT_URI", Settings.google_oauth_redirect_uri
        ).strip(),
        discord_oauth_client_id=os.getenv("AISU_DISCORD_OAUTH_CLIENT_ID", "").strip(),
        discord_oauth_client_secret=os.getenv("AISU_DISCORD_OAUTH_CLIENT_SECRET", "").strip(),
        discord_oauth_redirect_uri=os.getenv(
            "AISU_DISCORD_OAUTH_REDIRECT_URI", Settings.discord_oauth_redirect_uri
        ).strip(),
    )


def parse_environment(value: str) -> str:
    normalized = value.strip().lower()
    if normalized not in {"development", "test", "production"}:
        raise ValueError("AISU_ENV must be development, test, or production")
    return normalized


def parse_upload_processing_mode(value: str) -> str:
    normalized = value.strip().lower()
    if normalized not in {"background", "external"}:
        raise ValueError("AISU_UPLOAD_PROCESSING_MODE must be background or external")
    return normalized


def parse_cors_origins(value: str) -> tuple[str, ...]:
    return tuple(origin.strip().rstrip("/") for origin in value.split(",") if origin.strip())


def parse_csv_tuple(value: str) -> tuple[str, ...]:
    return tuple(item.strip().lower().rstrip(".") for item in value.split(",") if item.strip())


def validate_production_settings(settings: Settings) -> None:
    if settings.environment != "production":
        return

    if settings.upload_processing_mode == "background":
        logger.warning(
            "AISU_UPLOAD_PROCESSING_MODE is 'background' in production: uploads are parsed "
            "by in-process BackgroundTasks and stay stuck in 'processing' forever if the "
            "process restarts. Prefer 'external' with the dedicated upload worker."
        )

    errors: list[str] = []
    if settings.jwt_secret == DEFAULT_JWT_SECRET or len(settings.jwt_secret) < 32:
        errors.append("AISU_JWT_SECRET must be set to a production secret with at least 32 characters")
    if len(settings.encryption_key) < 32:
        errors.append("AISU_ENCRYPTION_KEY must be a separate production secret with at least 32 characters")
    if settings.ai_translation_global_daily_call_budget <= 0:
        errors.append("AISU_AI_TRANSLATION_GLOBAL_DAILY_CALL_BUDGET must be a positive production hard cap")
    if any(len(value) != 64 or any(char not in "0123456789abcdef" for char in value)
           for value in settings.ai_platform_credential_sha256):
        errors.append("AISU_AI_PLATFORM_CREDENTIAL_SHA256 must contain SHA-256 hex fingerprints")
    if settings.default_admin_password == DEFAULT_ADMIN_PASSWORD or len(settings.default_admin_password) < 12:
        errors.append("AISU_DEFAULT_ADMIN_PASSWORD must be changed for production")
    if settings.auto_create_tables:
        errors.append("AISU_AUTO_CREATE_TABLES must be false in production")
    if settings.seed_demo_data:
        errors.append("AISU_SEED_DEMO_DATA must be false in production")
    if not settings.cors_origins_explicit or not settings.cors_origins:
        errors.append("AISU_CORS_ORIGINS must be explicitly configured in production")
    if any(origin == "*" for origin in settings.cors_origins):
        errors.append("AISU_CORS_ORIGINS must not contain * in production")
    for origin in settings.cors_origins:
        if origin != "*" and urlparse(origin).scheme != "https":
            errors.append("AISU_CORS_ORIGINS must use https origins in production")
            break

    if settings.ai_translation_api_key or settings.ai_translation_base_url:
        parsed_ai_url = urlparse(settings.ai_translation_base_url)
        if parsed_ai_url.scheme != "https" or not parsed_ai_url.hostname:
            errors.append("AISU_AI_TRANSLATION_BASE_URL must be an https URL")
        elif parsed_ai_url.hostname.lower().rstrip(".") not in settings.ai_allowed_base_hosts:
            errors.append("AISU_AI_TRANSLATION_BASE_URL host must be listed in AISU_AI_ALLOWED_BASE_HOSTS")
        if not settings.ai_translation_api_key:
            errors.append("AISU_AI_TRANSLATION_API_KEY must be set when AI translation is configured")

    if errors:
        raise RuntimeError("Unsafe production configuration: " + "; ".join(errors))
