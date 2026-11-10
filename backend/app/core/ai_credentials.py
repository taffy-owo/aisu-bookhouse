"""Identify who pays for an AI key from the credential itself."""

import hashlib
import hmac

from app.core.config import Settings


def is_platform_ai_credential(api_key: str, settings: Settings) -> bool:
    if not api_key:
        return False
    if settings.ai_platform_builtin_api_key and hmac.compare_digest(api_key, settings.ai_platform_builtin_api_key):
        return True
    fingerprint = hashlib.sha256(api_key.encode("utf-8")).hexdigest()
    return any(hmac.compare_digest(fingerprint, candidate) for candidate in settings.ai_platform_credential_sha256)
