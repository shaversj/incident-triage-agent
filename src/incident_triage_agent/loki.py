from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from loguru import logger

from .domain import Evidence, SourceTier


log = logger.bind(component="loki")


class LokiClientError(Exception):
    """Raised when Loki lookup fails before returning usable log entries."""


@dataclass(frozen=True)
class LokiLogEntry:
    timestamp_ns: str
    line: str
    labels: dict[str, str]


class LokiClient:
    def __init__(
        self,
        base_url: str,
        timeout_seconds: int = 10,
        opener: Callable[..., Any] | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.opener = opener or urlopen

    def query_range(
        self,
        labels: dict[str, str],
        start_ns: int,
        end_ns: int,
        limit: int = 20,
        direction: str = "backward",
    ) -> tuple[LokiLogEntry, ...]:
        query = _selector(labels)
        params = urlencode(
            {
                "query": query,
                "start": str(start_ns),
                "end": str(end_ns),
                "limit": str(limit),
                "direction": direction,
            }
        )
        request = Request(f"{self.base_url}/loki/api/v1/query_range?{params}", method="GET")
        log.info("Querying Loki for labels {} with limit {}.", labels, limit)

        try:
            with self.opener(request, timeout=self.timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            raise LokiClientError(f"Loki HTTP error: {error.code}.") from error
        except URLError as error:
            raise LokiClientError(f"Loki request failed: {error.reason}.") from error
        except TimeoutError as error:
            raise LokiClientError("Loki request timed out.") from error
        except json.JSONDecodeError as error:
            raise LokiClientError("Loki response was not valid JSON.") from error

        return _entries_from_payload(payload, limit)

    @staticmethod
    def to_evidence(entries: tuple[LokiLogEntry, ...]) -> tuple[Evidence, ...]:
        evidence: list[Evidence] = []
        for index, entry in enumerate(entries):
            label_text = ", ".join(f"{key}={value}" for key, value in sorted(entry.labels.items()))
            evidence.append(
                Evidence(
                    evidence_id=f"log:{index}",
                    source="log",
                    source_tier=SourceTier.OPERATIONAL_CONTEXT,
                    summary=entry.line,
                    detail=f"{entry.timestamp_ns} {label_text}".strip(),
                )
            )
        return tuple(evidence)


def _selector(labels: dict[str, str]) -> str:
    if not labels:
        raise LokiClientError("At least one Loki label is required.")
    label_parts = [f'{key}="{_escape_label_value(value)}"' for key, value in sorted(labels.items())]
    return "{" + ",".join(label_parts) + "}"


def _escape_label_value(value: str) -> str:
    return str(value).replace("\\", "\\\\").replace('"', '\\"')


def _entries_from_payload(payload: dict[str, Any], limit: int) -> tuple[LokiLogEntry, ...]:
    if payload.get("status") != "success":
        raise LokiClientError("Loki response status was not success.")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise LokiClientError("Loki response data was missing.")
    result = data.get("result")
    if not isinstance(result, list):
        raise LokiClientError("Loki response result was missing.")

    entries: list[LokiLogEntry] = []
    for stream in result:
        if not isinstance(stream, dict):
            continue
        labels = stream.get("stream")
        values = stream.get("values")
        if not isinstance(labels, dict) or not isinstance(values, list):
            continue
        clean_labels = {str(key): str(value) for key, value in labels.items()}
        for value in values:
            if not (
                isinstance(value, list)
                and len(value) >= 2
                and isinstance(value[0], str)
                and isinstance(value[1], str)
            ):
                continue
            entries.append(LokiLogEntry(timestamp_ns=value[0], line=value[1], labels=clean_labels))
            if len(entries) >= limit:
                return tuple(entries)
    log.info("Loki returned {} usable log entries.", len(entries))
    return tuple(entries)
