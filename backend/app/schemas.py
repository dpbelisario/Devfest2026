"""Pydantic schemas for API requests and responses."""

from pydantic import BaseModel


class HealthResponse(BaseModel):
    """Response body for the health check."""

    ok: bool
