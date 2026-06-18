import json
import unittest
from urllib.error import URLError

from services.synthetic_checkout_service import LokiPushError, build_loki_payload, push_loki_logs


class FakeResponse:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return b""


class SyntheticCheckoutServiceTests(unittest.TestCase):
    def test_build_loki_payload_uses_queryable_service_labels_and_runtime_checkout_id(self) -> None:
        payload = build_loki_payload(
            service_name="checkout-api",
            checkout_id="checkout-123",
            timestamp_ns="1781622420000000000",
        )

        stream = payload["streams"][0]
        self.assertEqual(stream["stream"]["service"], "checkout-api")
        self.assertEqual(stream["stream"]["component"], "synthetic-checkout")
        self.assertGreaterEqual(len(stream["values"]), 2)
        for timestamp, line in stream["values"]:
            self.assertEqual(timestamp, "1781622420000000000")
            self.assertIn("checkout-123", line)

    def test_build_loki_payload_supports_capacity_and_bad_deploy_scenarios(self) -> None:
        capacity = build_loki_payload(
            service_name="search-api",
            checkout_id="capacity-123",
            timestamp_ns="1781625780000000000",
            scenario="capacity-saturation",
        )
        bad_deploy = build_loki_payload(
            service_name="checkout-api",
            checkout_id="bad-deploy-123",
            timestamp_ns="1781627400000000000",
            scenario="bad-deploy-latency",
        )

        self.assertEqual(capacity["streams"][0]["stream"]["service"], "search-api")
        self.assertEqual(capacity["streams"][0]["stream"]["scenario"], "capacity-saturation")
        self.assertIn("queue_depth", capacity["streams"][0]["values"][0][1])
        self.assertEqual(bad_deploy["streams"][0]["stream"]["service"], "checkout-api")
        self.assertEqual(bad_deploy["streams"][0]["stream"]["scenario"], "bad-deploy-latency")
        self.assertIn("v2.19.0", bad_deploy["streams"][0]["values"][0][1])

    def test_push_loki_logs_posts_to_loki_push_endpoint(self) -> None:
        seen: dict[str, object] = {}

        def opener(request, timeout):
            seen["url"] = request.full_url
            seen["timeout"] = timeout
            seen["body"] = json.loads(request.data.decode("utf-8"))
            seen["content_type"] = request.headers["Content-type"]
            return FakeResponse()

        payload = build_loki_payload(
            service_name="checkout-api",
            checkout_id="checkout-123",
            timestamp_ns="1781622420000000000",
        )

        push_loki_logs("http://loki:3100", payload, opener=opener)

        self.assertEqual(seen["url"], "http://loki:3100/loki/api/v1/push")
        self.assertEqual(seen["timeout"], 10)
        self.assertEqual(seen["body"], payload)
        self.assertEqual(seen["content_type"], "application/json")

    def test_push_loki_logs_wraps_downstream_failures_without_secret_values(self) -> None:
        def opener(_request, timeout):
            self.assertEqual(timeout, 10)
            raise URLError("connection refused")

        payload = build_loki_payload(
            service_name="checkout-api",
            checkout_id="checkout-123",
            timestamp_ns="1781622420000000000",
        )

        with self.assertRaises(LokiPushError) as context:
            push_loki_logs("http://loki:3100", payload, opener=opener)

        self.assertIn("Loki request failed", str(context.exception))
        self.assertNotIn("checkout-123", str(context.exception))


if __name__ == "__main__":
    unittest.main()
