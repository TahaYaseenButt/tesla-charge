#!/usr/bin/env python3
"""
==============================================================================
⚡ T-CHARGE PYTHON OCPP 1.6-J SERVER STRESS & BOMBARDMENT TEST SUITE
==============================================================================
Requirements:
    pip install websockets

Usage:
    python3 stress_test.py
    TARGET_URL=wss://tesla-charge.online CONCURRENCY=100 TOTAL_MESSAGES=10000 python3 stress_test.py
==============================================================================
"""

import asyncio
import json
import os
import sys
import time
import random

try:
    import websockets
except ImportError:
    print("❌ 'websockets' package is required. Install it using:")
    print("   pip install websockets")
    sys.exit(1)

TARGET_HOST = os.getenv("TARGET_URL", "wss://tesla-charge.online")
CONCURRENCY = int(os.getenv("CONCURRENCY", "50"))
TOTAL_MESSAGES = int(os.getenv("TOTAL_MESSAGES", "2000"))
CHAOS_MODE = os.getenv("CHAOS", "false").lower() == "true"

stats = {
    "connected": 0,
    "connection_errors": 0,
    "sent": 0,
    "received": 0,
    "timed_out": 0,
    "latencies": [],
}


def get_percentile(arr, p):
    if not arr:
        return 0
    sorted_arr = sorted(arr)
    k = (len(sorted_arr) - 1) * (p / 100.0)
    f = int(k)
    c = min(f + 1, len(sorted_arr) - 1)
    d = k - f
    return sorted_arr[f] * (1 - d) + sorted_arr[c] * d


async def charger_worker(charger_id: str, messages_to_send: int):
    url = f"{TARGET_HOST}/api/ocpp/version/1.6/{charger_id}"
    try:
        async with websockets.connect(
            url,
            subprotocols=["ocpp1.6"],
            ping_interval=20,
            ping_timeout=10,
            close_timeout=5,
        ) as ws:
            stats["connected"] += 1

            actions = [
                (
                    "BootNotification",
                    {
                        "chargePointVendor": "TeslaStressPython",
                        "chargePointModel": "Model-S-Supercharger",
                    },
                ),
                (
                    "StatusNotification",
                    {"connectorId": 1, "errorCode": "NoError", "status": "Charging"},
                ),
                (
                    "MeterValues",
                    {
                        "connectorId": 1,
                        "transactionId": 1001,
                        "meterValue": [
                            {
                                "timestamp": time.strftime(
                                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                                ),
                                "sampledValue": [
                                    {
                                        "value": "240.5",
                                        "measurand": "Power.Active.Import",
                                    }
                                ],
                            }
                        ],
                    },
                ),
                ("Heartbeat", {}),
                ("Authorize", {"idTag": "TEST_PY_TAG_01"}),
            ]

            for i in range(messages_to_send):
                action, payload = actions[i % len(actions)]
                msg_id = f"py_{charger_id}_{random.randint(10000, 99999)}"
                req = [2, msg_id, action, payload]

                t_start = time.perf_counter()
                stats["sent"] += 1
                await ws.send(json.dumps(req))

                try:
                    # Await CALLRESULT with 3s timeout
                    raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
                    lat_ms = (time.perf_counter() - t_start) * 1000.0
                    stats["latencies"].append(lat_ms)
                    stats["received"] += 1
                except asyncio.TimeoutError:
                    stats["timed_out"] += 1

                # Occasional chaos corrupted payload
                if CHAOS_MODE and i % 25 == 0:
                    try:
                        await ws.send(f'[2, "chaos_{i}", "CorruptPayload"')
                        stats["sent"] += 1
                    except Exception:
                        pass

    except Exception as e:
        stats["connection_errors"] += 1


async def main():
    print("=" * 66)
    print("⚡ T-CHARGE PYTHON SERVER STRESS & OVERLOAD TEST SUITE")
    print("=" * 66)
    print(f"🌐 Target URL:          {TARGET_HOST}")
    print(f"🔌 Concurrent Chargers: {CONCURRENCY}")
    print(f"📨 Total Operations:    {TOTAL_MESSAGES}")
    print(f"💣 Chaos Mode:          {CHAOS_MODE}")
    print("=" * 66 + "\n")

    msgs_per_charger = max(1, TOTAL_MESSAGES // CONCURRENCY)
    t_start = time.perf_counter()

    tasks = [
        charger_worker(f"py_charger_{i:04d}", msgs_per_charger)
        for i in range(CONCURRENCY)
    ]
    await asyncio.gather(*tasks, return_exceptions=True)

    t_total = time.perf_counter() - t_start
    lats = stats["latencies"]
    avg_lat = sum(lats) / len(lats) if lats else 0
    p95 = get_percentile(lats, 95)
    p99 = get_percentile(lats, 99)
    rps = stats["received"] / t_total if t_total else 0
    delivery_rate = (stats["received"] / stats["sent"] * 100) if stats["sent"] else 0

    print("\n" + "=" * 66)
    print("📊 T-CHARGE PYTHON BENCHMARK & APPROVAL SUMMARY")
    print("=" * 66)
    print(f"⏱️  Duration:           {t_total:.2f} seconds")
    print(f"🔌 Connected Sockets:  {stats['connected']}/{CONCURRENCY}")
    print(f"📤 Sent Operations:    {stats['sent']}")
    print(f"📥 Received CallResults:{stats['received']}")
    print(f"⚡ Throughput (RPS):   {rps:.1f} reqs/sec")
    print(f"🎯 Delivery Rate:      {delivery_rate:.2f}%")
    print(f"⏱️  Avg Latency:        {avg_lat:.2f} ms")
    print(f"⏱️  p95 Latency:        {p95:.2f} ms")
    print(f"⏱️  p99 Latency:        {p99:.2f} ms")
    print(f"⚠️  Timeouts:          {stats['timed_out']}")
    print("=" * 66)

    if delivery_rate >= 95 and p95 <= 800 and stats["connection_errors"] == 0:
        print("🏆 SERVER APPROVAL STATUS: [ PASSED / APPROVED ]")
    else:
        print("⚠️ SERVER APPROVAL STATUS: [ REQUIRES TUNING ]")
    print("=" * 66 + "\n")


if __name__ == "__main__":
    asyncio.run(main())
