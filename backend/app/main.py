from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi

from app.api.v1.router import api_router
from app.core.bootstrap import bootstrap_database
from app.core.config import Settings, get_settings, validate_production_settings
from app.core.database import create_database_engine, create_database_schema, create_session_factory
from app.core.maintenance import ensure_no_restore_in_progress


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or get_settings()
    validate_production_settings(resolved_settings)
    ensure_no_restore_in_progress(resolved_settings)

    engine = create_database_engine(resolved_settings)
    session_factory = create_session_factory(engine)

    if resolved_settings.auto_create_tables:
        create_database_schema(engine)
    if resolved_settings.bootstrap_admin or resolved_settings.seed_demo_data:
        bootstrap_database(session_factory, resolved_settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            engine.dispose()

    app = FastAPI(title=resolved_settings.product_name, lifespan=lifespan)

    app.state.settings = resolved_settings
    app.state.db_engine = engine
    app.state.db_session_factory = session_factory

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved_settings.cors_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(api_router, prefix=resolved_settings.api_prefix)

    def schema():
        if app.openapi_schema is None:
            generated = get_openapi(title=resolved_settings.product_name, version="1.0.0", routes=app.routes)
            generated.setdefault("components", {}).setdefault("securitySchemes", {})["BearerAuth"] = {
                "type": "http", "scheme": "bearer", "description": "账号访问令牌或按接口权限授权的个人 API 凭据；项目接口亦接受限定项目令牌。"}
            for path in generated["paths"].values():
                for operation in path.values():
                    if not isinstance(operation, dict):
                        continue
                    parameters = operation.get("parameters", [])
                    if any(p.get("in") == "header" and p.get("name", "").lower() == "authorization" for p in parameters):
                        operation["security"] = [{"BearerAuth": []}]
                        operation["parameters"] = [p for p in parameters if p.get("name", "").lower() != "authorization"]
            app.openapi_schema = generated
        return app.openapi_schema

    app.openapi = schema

    @app.get(resolved_settings.api_prefix + "/openapi.json", include_in_schema=False)
    def integration_schema():
        return app.openapi()

    return app


app = create_app()
