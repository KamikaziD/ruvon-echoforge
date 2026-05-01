"""FastAPI bridge — tick ingestion, PHIC config, metrics WebSocket."""

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .tick import router as tick_router
from .phic import router as phic_router, phic_state
from .metrics import router as metrics_router, metrics_broadcaster


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(metrics_broadcaster())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


def create_app() -> FastAPI:
    app = FastAPI(
        title="EchoForge Bridge",
        description="Tick ingestion, PHIC governance, and metrics WebSocket for the EchoForge Syndicate",
        version="0.1.1",
        lifespan=lifespan,
    )

    raw_origins = os.getenv("ECHOFORGE_CORS_ORIGINS", "*")
    # allow_origins=["*"] + allow_credentials=True is invalid per CORS spec —
    # browsers reject the combination. Use allow_origin_regex for wildcard with creds.
    if raw_origins.strip() == "*":
        app.add_middleware(
            CORSMiddleware,
            allow_origin_regex=".*",
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
    else:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=raw_origins.split(","),
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    app.include_router(tick_router, prefix="/api/v1")
    app.include_router(phic_router, prefix="/api/v1")
    app.include_router(metrics_router, prefix="/api/v1")

    return app


app = create_app()


def cli():
    """Entry point for `echoforge` CLI command."""
    import uvicorn

    host = os.getenv("ECHOFORGE_HOST", "0.0.0.0")
    port = int(os.getenv("ECHOFORGE_PORT", "8765"))
    uvicorn.run("ruvon_echoforge.bridge.main:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    cli()
