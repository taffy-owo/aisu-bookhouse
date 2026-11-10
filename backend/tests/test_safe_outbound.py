import asyncio
import socket

import httpx
import pytest

from app.core.safe_outbound import PinnedPublicTransport


def test_public_dns_is_pinned_with_original_tls_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))])
    seen: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"ok": True})

    async def run() -> None:
        async with httpx.AsyncClient(transport=PinnedPublicTransport(httpx.MockTransport(respond))) as client:
            response = await client.get("https://provider.example/v1/models")
            assert response.status_code == 200

    asyncio.run(run())
    assert seen[0].url.host == "8.8.8.8"
    assert seen[0].headers["host"] == "provider.example"
    assert seen[0].extensions["sni_hostname"] == "provider.example"


@pytest.mark.parametrize("answers", [["127.0.0.1"], ["8.8.8.8", "10.0.0.2"], ["fe80::1"]])
def test_any_private_dns_answer_blocks_request(monkeypatch: pytest.MonkeyPatch, answers: list[str]) -> None:
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in answers])
    calls: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200)

    async def run() -> None:
        async with httpx.AsyncClient(transport=PinnedPublicTransport(httpx.MockTransport(respond))) as client:
            with pytest.raises(ValueError, match="非公网"):
                await client.get("https://provider.example/v1/models")

    asyncio.run(run())
    assert calls == []


def test_nonstandard_port_is_blocked_before_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: pytest.fail("DNS should not be used"))

    async def run() -> None:
        async with httpx.AsyncClient(transport=PinnedPublicTransport(httpx.MockTransport(lambda request: httpx.Response(200)))) as client:
            with pytest.raises(ValueError, match="443"):
                await client.get("https://provider.example:8443/models")

    asyncio.run(run())
