import json
import unittest
from urllib.error import URLError

from incident_triage_agent.domain import SourceTier
from incident_triage_agent.loki import LokiClient, LokiClientError, LokiLogEntry


class FakeResponse:
    def __init__(self, payload: dict) -> None:
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


class LokiClientTests(unittest.TestCase):
    def test_query_range_builds_bounded_request_and_returns_entries(self) -> None:
        seen: dict[str, object] = {}

        def opener(request, timeout):
            seen["url"] = request.full_url
            seen["timeout"] = timeout
            return FakeResponse(
                {
                    "status": "success",
                    "data": {
                        "resultType": "streams",
                        "result": [
                            {
                                "stream": {"service": "checkout-api"},
                                "values": [
                                    ["1781622420000000000", "payment timeout after 3000ms"],
                                    ["1781622430000000000", "retry queue depth increasing"],
                                ],
                            }
                        ],
                    },
                }
            )

        client = LokiClient("http://loki:3100", opener=opener)

        entries = client.query_range(
            labels={"service": "checkout-api"},
            start_ns=1781622300000000000,
            end_ns=1781622600000000000,
            limit=2,
            direction="forward",
        )

        self.assertEqual(seen["timeout"], 10)
        self.assertIn("/loki/api/v1/query_range", str(seen["url"]))
        self.assertIn("query=%7Bservice%3D%22checkout-api%22%7D", str(seen["url"]))
        self.assertIn("limit=2", str(seen["url"]))
        self.assertIn("direction=forward", str(seen["url"]))
        self.assertEqual(
            entries,
            (
                LokiLogEntry(
                    timestamp_ns="1781622420000000000",
                    line="payment timeout after 3000ms",
                    labels={"service": "checkout-api"},
                ),
                LokiLogEntry(
                    timestamp_ns="1781622430000000000",
                    line="retry queue depth increasing",
                    labels={"service": "checkout-api"},
                ),
            ),
        )

    def test_to_evidence_uses_operational_context_and_stable_ids(self) -> None:
        entries = (
            LokiLogEntry("1781622420000000000", "payment timeout after 3000ms", {"service": "checkout-api"}),
        )

        evidence = LokiClient.to_evidence(entries)

        self.assertEqual(evidence[0].evidence_id, "log:0")
        self.assertEqual(evidence[0].source, "log")
        self.assertEqual(evidence[0].source_tier, SourceTier.OPERATIONAL_CONTEXT)
        self.assertIn("payment timeout", evidence[0].summary)

    def test_query_range_errors_are_bounded(self) -> None:
        def opener(_request, timeout):
            self.assertEqual(timeout, 10)
            raise URLError("connection refused")

        client = LokiClient("http://loki:3100", opener=opener)

        with self.assertRaises(LokiClientError):
            client.query_range(labels={"service": "checkout-api"}, start_ns=1, end_ns=2)


if __name__ == "__main__":
    unittest.main()
