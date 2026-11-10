"""Per-account hold while replacing a translation workflow; not a new pipeline."""
from pathlib import Path
import re

from fastapi import HTTPException
from app.core.config import Settings

MAINTENANCE_MESSAGE = '翻译流程已停用，等待重新设计；模型、渠道和已有图书已保留'


def translation_is_suspended(settings: Settings, user_id: str) -> bool:
    if not re.fullmatch(r'[A-Za-z0-9-]+', user_id):
        raise ValueError('Invalid translation account path')
    return (Path(settings.storage_root).resolve() / 'translation-maintenance' / (user_id+'.json')).is_file()


def require_translation_active(settings: Settings, user_id: str) -> None:
    if translation_is_suspended(settings,user_id):
        raise HTTPException(status_code=503,detail=MAINTENANCE_MESSAGE)
