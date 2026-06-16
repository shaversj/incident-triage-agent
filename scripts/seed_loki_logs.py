from __future__ import annotations

import argparse
import json
import time
from urllib.request import Request, urlopen


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed synthetic incident logs into Loki.")
    parser.add_argument("--loki-url", default="http://localhost:3100")
    parser.add_argument("--service", default="checkout-api")
    args = parser.parse_args()

    now_ns = str(int(time.time() * 1_000_000_000))
    payload = {
        "streams": [
            {
                "stream": {"service": args.service},
                "values": [
                    [now_ns, "payment timeout after 3000ms for checkout request"],
                    [now_ns, "retry queue depth increasing for payment gateway"],
                ],
            }
        ]
    }
    body = json.dumps(payload).encode("utf-8")
    request = Request(
        f"{args.loki_url.rstrip('/')}/loki/api/v1/push",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=10) as response:
        response.read()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
