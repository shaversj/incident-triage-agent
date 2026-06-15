from __future__ import annotations

import sys

from loguru import logger


LOG_FORMAT = (
    "<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | "
    "<level>{level: <8}</level> | "
    "{extra[component]} | "
    "<level>{message}</level>"
)


def configure_logging(level: str) -> None:
    logger.remove()
    logger.enable("incident_triage_agent")
    logger.configure(extra={"component": "triage"})
    logger.add(sys.stderr, level=level.upper(), format=LOG_FORMAT)
