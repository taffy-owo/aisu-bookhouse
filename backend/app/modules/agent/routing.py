"""Bound JSON bodies before FastAPI/Pydantic materializes them."""

from fastapi import HTTPException, Request
from fastapi.routing import APIRoute
from fastapi.exceptions import RequestValidationError


MAX_REQUEST_BYTES = 8 * 1024 * 1024


class AgentRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def bounded(request: Request):
            if request.method in {"POST", "PUT", "PATCH"}:
                chunks = []
                size = 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_REQUEST_BYTES:
                        raise HTTPException(413, "请求超过 8 MiB 限制，请按章节提交")
                    chunks.append(chunk)
                request._body = b"".join(chunks)
            try:
                response = await handler(request)
            except RequestValidationError as error:
                # Never echo arbitrary input (including malformed Unicode or
                # credentials) while describing validation failures.
                raise HTTPException(422, [{k: e[k] for k in ("loc", "msg", "type")} for e in error.errors()]) from error
            except RecursionError as error:
                raise HTTPException(422, "JSON 嵌套层数过深") from error
            response.headers["Cache-Control"] = "no-store"
            return response

        return bounded
