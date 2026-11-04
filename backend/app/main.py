"""FastAPI entry point served by Cloud Run.

Every route lives under ``/api`` so Firebase Hosting can forward ``/api/**`` to this
service while serving the frontend from the same domain (no CORS needed).
"""

from fastapi import FastAPI

from app.schemas import HealthResponse

app = FastAPI(
    title="DevFest 2026 API", docs_url="/api/docs", openapi_url="/api/openapi.json"
)


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Report that the service is up.

    @return A ``HealthResponse`` with ``ok`` set to ``True``.
    """
    return HealthResponse(ok=True)
