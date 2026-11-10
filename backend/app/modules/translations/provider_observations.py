"""Request-scoped evidence for recovery; cached output is not a provider probe."""
from collections.abc import Callable, Hashable
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from threading import Lock


@dataclass
class ProviderProbe:
    base_url: str
    model: str
    capture: Callable[[], Hashable | None]
    versions: set[Hashable] = field(default_factory=set, repr=False)
    lock: Lock = field(default_factory=Lock, repr=False)

    def take_versions(self) -> tuple[Hashable, ...]:
        with self.lock:
            versions = tuple(self.versions)
            self.versions.clear()
            return versions


@dataclass(frozen=True)
class ProviderAttempt:
    probe: ProviderProbe
    version: Hashable | None


current_provider_probe: ContextVar[ProviderProbe | None] = ContextVar('current_provider_probe', default=None)


@contextmanager
def provider_probe_scope(base_url: str, model: str, capture: Callable[[], Hashable | None]):
    probe = ProviderProbe(base_url.rstrip('/'), model, capture)
    token = current_provider_probe.set(probe)
    try:
        yield probe
    finally:
        current_provider_probe.reset(token)


def begin_provider_attempt(base_url: str, model: str) -> ProviderAttempt | None:
    probe = current_provider_probe.get()
    if probe is None or probe.base_url != base_url.rstrip('/') or probe.model != model:
        return None
    return ProviderAttempt(probe, probe.capture())


def record_provider_success(attempt: ProviderAttempt | None) -> None:
    if attempt is not None and attempt.version is not None and getattr(attempt.version, 'unavailable', True):
        with attempt.probe.lock:
            attempt.probe.versions.add(attempt.version)


def attach_provider_failure(error: Exception, attempt: ProviderAttempt | None) -> None:
    if current_provider_probe.get() is not None:
        error._provider_availability_version = attempt.version if attempt is not None else None


def has_recovery_probe() -> bool:
    probe = current_provider_probe.get()
    if probe is None:
        return False
    with probe.lock:
        return bool(probe.versions)
