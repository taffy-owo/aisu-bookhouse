"""HTTPS transport for user-configurable providers with DNS-to-connection pinning."""

import asyncio
import ipaddress
import socket

import httpx


class UnsafeOutboundAddressError(ValueError):
    """A provider endpoint failed the public HTTPS/DNS safety boundary."""


def public_address(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        return False


async def resolve_public_address(host: str, port: int) -> str:
    try:
        addresses = await asyncio.to_thread(socket.getaddrinfo, host, port, type=socket.SOCK_STREAM)
    except OSError as error:
        raise UnsafeOutboundAddressError("AI 服务域名无法解析") from error
    ips = list(dict.fromkeys(item[4][0] for item in addresses))
    if not ips or any(not public_address(ip) for ip in ips):
        raise UnsafeOutboundAddressError("AI 服务域名解析到了非公网地址")
    return ips[0]


class PinnedPublicTransport(httpx.AsyncBaseTransport):
    def __init__(self, inner: httpx.AsyncBaseTransport | None = None) -> None:
        self._inner = inner or httpx.AsyncHTTPTransport(retries=0)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.scheme != "https" or not url.host or url.port not in (None, 443):
            raise UnsafeOutboundAddressError("AI 服务地址必须使用 HTTPS 的 443 端口")
        host = url.host.rstrip(".")
        ip = host if public_address(host) else await resolve_public_address(host, 443)
        if not public_address(ip):
            raise UnsafeOutboundAddressError("AI 服务地址不能指向非公网 IP")
        headers = request.headers.copy()
        headers["Host"] = host
        extensions = dict(request.extensions)
        extensions["sni_hostname"] = host
        pinned = httpx.Request(
            request.method, url.copy_with(host=ip), headers=headers,
            stream=request.stream, extensions=extensions,
        )
        return await self._inner.handle_async_request(pinned)

    async def aclose(self) -> None:
        await self._inner.aclose()


def public_https_client(*, timeout: float | httpx.Timeout) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=timeout, follow_redirects=False, trust_env=False,
        transport=PinnedPublicTransport(),
    )
