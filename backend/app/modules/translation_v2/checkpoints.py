"""Atomic V2 checkpoints and validated provider receipts; damage never sends a new call."""
import hashlib
import json
import os
from pathlib import Path
import time
from uuid import uuid4

from pydantic import ValidationError
from .errors import TrialError


def digest(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def ensure_storage_parent(path: Path) -> None:
    # Maintenance commands may run as root in service-owned storage. Atomic
    # replacement creates a new inode, so mode 0600 alone would lock the service
    # out. Inherit the storage directory's owner, including newly created parents.
    privileged = os.name == 'posix' and os.geteuid() == 0
    missing = []
    parent = path.parent
    if privileged:
        while not parent.exists():
            missing.append(parent)
            parent = parent.parent
        owner = parent.stat()
        for directory in reversed(missing):
            try:
                directory.mkdir()
            except FileExistsError:
                pass  # A concurrent writer owns its directory creation.
            else:
                os.chown(directory, owner.st_uid, owner.st_gid)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)


def save_json(path: Path, value: object) -> None:
    ensure_storage_parent(path)
    privileged = os.name == 'posix' and os.geteuid() == 0
    tmp = path.with_name('.' + path.name + '.' + uuid4().hex + '.tmp')
    try:
        with tmp.open("x", encoding="utf-8", newline="\n") as handle:
            if privileged:
                owner = path.parent.stat()
                os.fchown(handle.fileno(), owner.st_uid, owner.st_gid)
            os.chmod(tmp, 0o600)
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        for attempt in range(7):
            try:
                os.replace(tmp, path)
                break
            except PermissionError as error:
                # Windows may briefly deny a rename while another atomic
                # replacement closes its handle. Never unlink the destination.
                if os.name != 'nt' or getattr(error, 'winerror', 0) not in {5, 32, 33} or attempt == 6:
                    raise
                time.sleep(.01 * 2 ** attempt)
    finally:
        tmp.unlink(missing_ok=True)
    if os.name == "posix":
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)



def _read_record(path, code, stage):
    try:
        record = json.loads(path.read_text(encoding='utf-8'))
    except (ValueError, UnicodeError) as error:
        raise TrialError(code, stage=stage) from error
    if not isinstance(record, dict):
        raise TrialError(code, stage=stage)
    return record


def load_checkpoint(path, fingerprint, schema, *, stage):
    record = _read_record(path, 'checkpoint_corrupt', stage)
    if (record.get('fingerprint') != fingerprint or 'output' not in record
            or digest(record['output']) != record.get('output_hash')):
        raise TrialError('checkpoint_corrupt', stage=stage)
    try:
        return schema.model_validate(record['output'])
    except ValidationError as error:
        raise TrialError('checkpoint_schema_invalid', stage=stage) from error


def load_provider_receipt(path, fingerprint, *, stage):
    record = _read_record(path, 'receipt_corrupt', stage)
    if (record.get('fingerprint') != fingerprint
            or not isinstance(record.get('body'), str)
            or digest(record['body']) != record.get('body_hash')
            or type(record.get('status')) is not int or not 100 <= record['status'] <= 999
            or not isinstance(record.get('content_type', ''), str)
            or type(record.get('decode_failed', False)) is not bool):
        raise TrialError('receipt_corrupt', stage=stage)
    return record
