from __future__ import annotations

from dataclasses import dataclass
import argparse
import json
import logging
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


log = logging.getLogger("synthetic_checkout_service")


class LokiPushError(Exception):
    """Raised when the synthetic service cannot send logs to Loki."""


@dataclass(frozen=True)
class ServiceConfig:
    host: str = "0.0.0.0"
    port: int = 8081
    loki_url: str = "http://localhost:3100"
    service_name: str = "checkout-api"


def build_loki_payload(
    *,
    service_name: str,
    checkout_id: str,
    timestamp_ns: str | None = None,
) -> dict[str, Any]:
    timestamp = timestamp_ns or str(int(time.time() * 1_000_000_000))
    return {
        "streams": [
            {
                "stream": {
                    "service": service_name,
                    "component": "synthetic-checkout",
                    "scenario": "payment-timeout",
                },
                "values": [
                    [timestamp, f"checkout_id={checkout_id} payment timeout after 3000ms"],
                    [timestamp, f"checkout_id={checkout_id} retry queue depth increasing for payment gateway"],
                    [timestamp, f"checkout_id={checkout_id} customer checkout failed after payment retries"],
                ],
            }
        ]
    }


def push_loki_logs(
    loki_url: str,
    payload: dict[str, Any],
    *,
    opener: Callable[..., Any] = urlopen,
    timeout_seconds: int = 10,
) -> None:
    body = json.dumps(payload).encode("utf-8")
    request = Request(
        f"{loki_url.rstrip('/')}/loki/api/v1/push",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with opener(request, timeout=timeout_seconds) as response:
            response.read()
    except HTTPError as error:
        raise LokiPushError(f"Loki HTTP error: {error.code}.") from error
    except URLError as error:
        raise LokiPushError(f"Loki request failed: {error.reason}.") from error
    except TimeoutError as error:
        raise LokiPushError("Loki request timed out.") from error


def serve(config: ServiceConfig) -> None:
    handler = _handler_for(config)
    httpd = ThreadingHTTPServer((config.host, config.port), handler)
    log.info("Starting synthetic checkout service on %s:%s.", config.host, config.port)
    httpd.serve_forever()


def _handler_for(config: ServiceConfig):
    class SyntheticCheckoutHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path != "/health":
                self._write_json(404, {"status": "error", "error": "not_found"})
                return
            self._write_json(200, {"status": "ok", "service": config.service_name})

        def do_POST(self) -> None:
            if self.path != "/checkout":
                self._write_json(404, {"status": "error", "error": "not_found"})
                return

            try:
                request_payload = self._read_request_payload()
            except ValueError as error:
                self._write_json(400, {"status": "error", "error": str(error)})
                return

            checkout_id = str(request_payload.get("checkout_id") or f"checkout-{int(time.time())}")
            payload = build_loki_payload(service_name=config.service_name, checkout_id=checkout_id)
            try:
                push_loki_logs(config.loki_url, payload)
            except LokiPushError:
                log.exception("Failed to push synthetic checkout logs to Loki.")
                self._write_json(502, {"status": "error", "error": "loki_push_failed"})
                return

            self._write_json(
                202,
                {
                    "status": "accepted",
                    "service": config.service_name,
                    "checkout_id": checkout_id,
                    "log_count": len(payload["streams"][0]["values"]),
                },
            )

        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def _read_request_payload(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 100_000:
                raise ValueError("payload_too_large")
            if length == 0:
                return {}
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError("invalid_json") from error
            if not isinstance(payload, dict):
                raise ValueError("payload_must_be_object")
            return payload

        def _write_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return SyntheticCheckoutHandler


def config_from_env() -> ServiceConfig:
    return ServiceConfig(
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8081")),
        loki_url=os.environ.get("LOKI_URL", "http://localhost:3100"),
        service_name=os.environ.get("SERVICE_NAME", "checkout-api"),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the synthetic checkout service.")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--loki-url", default=None)
    parser.add_argument("--service-name", default=None)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    env_config = config_from_env()
    config = ServiceConfig(
        host=args.host or env_config.host,
        port=args.port or env_config.port,
        loki_url=args.loki_url or env_config.loki_url,
        service_name=args.service_name or env_config.service_name,
    )
    serve(config)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
