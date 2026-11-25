"""Pretend to be the ESP32 so you can preview AlertNet before the hardware is installed.

    python simulate_device.py                 # normal readings, runs until Ctrl+C
    python simulate_device.py --hazard        # temperature climbs until the alarm trips
    python simulate_device.py --url https://your-app.onrender.com

Uses only the standard library. It sends the same requests the real device will.
"""
import argparse
import os
import json
import random
import time
import urllib.request

DEVICE_ID = "alertnet01"
API_KEY = os.environ.get("ALERTNET_API_KEY", "")


def call(url, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    if API_KEY:
        headers["X-API-Key"] = API_KEY
    req = urllib.request.Request(
        url, data=data, headers=headers,
        method="GET" if payload is None else "POST",
    )
    with urllib.request.urlopen(req, timeout=5) as res:
        return json.load(res)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8000")
    ap.add_argument("--interval", type=float, default=2.0, help="seconds between readings")
    ap.add_argument("--hazard", action="store_true", help="heat up until the hazard trips, then cool down")
    ap.add_argument("--outage", type=float, default=0, help="go silent for N seconds after reading 15 (to see the health panel react)")
    ap.add_argument("--key", default="", help="access key (or set ALERTNET_API_KEY)")
    ap.add_argument("--count", type=int, default=0, help="stop after N readings (0 = run forever)")
    args = ap.parse_args()
    global API_KEY
    if args.key:
        API_KEY = args.key
    base = args.url.rstrip("/")

    try:
        saved = call(f"{base}/api/settings")
    except Exception:
        saved = {}
    limit_c = saved.get("temperature_c", 58)
    limit_gas = saved.get("gas", 750)

    temp, hum, gas, angle = 27.0, 60.0, 250.0, 0.0
    tick, tripped = 0, False
    started = time.time()
    rssi = -60.0
    print(f"Simulating {DEVICE_ID} -> {base}  (Ctrl+C to stop)")

    while args.count == 0 or tick < args.count:
        tick += 1
        if args.outage and tick == 15:
            print(f"Going silent for {args.outage:.0f} s to simulate an outage...")
            time.sleep(args.outage)
        rssi = max(-90.0, min(-45.0, rssi + random.uniform(-2, 2)))
        try:
            control = call(f"{base}/api/control/{DEVICE_ID}")
        except Exception:
            control = {}
        pump_on = bool(control.get("pump"))
        manual = bool(control.get("manual_override"))

        # scanner: sweep, or move toward the manual target angle
        if manual:
            target = float(control.get("target_angle") or 0)
            diff = (target - angle + 540) % 360 - 180
            angle = (angle + max(-15, min(15, diff))) % 360
        else:
            angle = (angle + 12) % 360

        # environment
        if args.hazard and tick > 10 and not tripped:
            temp += 2.0
        elif pump_on:
            temp -= 2.5
        else:
            temp += random.uniform(-0.4, 0.4) + (27.0 - temp) * 0.05
        temp = max(20.0, temp)
        hum = min(95.0, max(30.0, hum + random.uniform(-0.8, 0.8)))
        gas = max(100.0, gas + random.uniform(-15, 15) + (250 - gas) * 0.05 + (60 if args.hazard and temp > limit_c - 13 else 0))
        flame = temp >= limit_c or (args.hazard and tick > 10 and temp > limit_c - 13)
        hazard = temp >= limit_c or gas >= limit_gas

        try:
            call(f"{base}/api/readings", {
                "device_id": DEVICE_ID, "temperature": round(temp, 1), "humidity": round(hum, 1),
                "gas_level": round(gas), "flame_detected": flame,
                "scan_angle": round(angle), "hazard_detected": hazard,
                "wifi_rssi": round(rssi), "uptime_s": round(time.time() - started),
            })

            if hazard and not tripped:
                tripped = True
                call(f"{base}/api/events", {
                    "device_id": DEVICE_ID, "event_type": "High temperature", "severity": "critical",
                    "temperature": round(temp, 1), "humidity": round(hum, 1), "gas_level": round(gas),
                    "scan_angle": round(angle), "action_taken": "Pump and alarm on",
                })
                if not manual:
                    call(f"{base}/api/control/{DEVICE_ID}", {
                        "pump": True, "alarm": True, "manual_override": False, "target_angle": round(angle)})
            elif tripped and temp < limit_c - 18:
                tripped = False
                gas = 250.0
                if not manual:
                    call(f"{base}/api/control/{DEVICE_ID}", {
                        "pump": False, "alarm": False, "manual_override": False, "target_angle": round(angle)})
            print(f"#{tick:<4} {temp:5.1f} C  {hum:4.1f} %  gas {gas:4.0f}  angle {angle:3.0f}  "
                  f"{'HAZARD' if hazard else 'ok'}  pump {'on' if pump_on else 'off'}")
        except Exception as exc:
            print(f"#{tick:<4} could not reach the server: {exc}")

        time.sleep(args.interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")