import hmac
import os
import time
from datetime import datetime, timezone
import socket
from pathlib import Path

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from database import DB_PATH, init_db, get_connection


TEMPERATURE_THRESHOLD_C = 58
GAS_THRESHOLD = 750


# ============================================================
# APPLICATION
# ============================================================

app = FastAPI(
    title="AlertNet Server",
    description="Centralized Hazard & Fire Response System",
    version="1.0"
)


# Initialize database
init_db()


# ============================================================
# ACCESS KEY (protects every route that changes something)
# ============================================================

API_KEY = os.getenv("ALERTNET_API_KEY", "")

if not API_KEY:
    print(
        "\nWARNING: ALERTNET_API_KEY is not set, so anyone who can reach this "
        "server can change controls and settings.\n"
        "Generate a key with:  python -c \"import secrets; print(secrets.token_urlsafe(32))\"\n"
    )


def require_key(x_api_key: str | None = Header(default=None)):

    if not API_KEY:
        return

    if not x_api_key or not hmac.compare_digest(x_api_key, API_KEY):
        time.sleep(0.5)  # slows down guessing
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


write_access = [Depends(require_key)]


# ============================================================
# DATA RETENTION (old rows are deleted automatically)
# ============================================================

def env_int(name: str, default: int) -> int:

    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


# 0 means keep everything
READINGS_RETENTION_DAYS = env_int("READINGS_RETENTION_DAYS", 7)
EVENTS_RETENTION_DAYS = env_int("EVENTS_RETENTION_DAYS", 90)
CLEANUP_EVERY_SECONDS = 3600

_last_cleanup = 0.0


def cleanup_old_data(force: bool = False) -> None:

    global _last_cleanup

    now = time.time()

    if not force and now - _last_cleanup < CLEANUP_EVERY_SECONDS:
        return

    _last_cleanup = now

    conn = get_connection()

    removed = {}

    for table, days in (
        ("sensor_readings", READINGS_RETENTION_DAYS),
        ("hazard_events", EVENTS_RETENTION_DAYS),
    ):
        if days > 0:
            cursor = conn.execute(
                f"DELETE FROM {table} WHERE created_at < datetime('now', ?)",
                (f"-{days} days",)
            )
            removed[table] = cursor.rowcount

    conn.commit()

    conn.close()

    if any(removed.values()):
        print(f"Cleanup removed old rows: {removed}")


cleanup_old_data(force=True)


# ============================================================
# DATA MODELS
# ============================================================

class SensorReading(BaseModel):

    device_id: str = "alertnet01"

    temperature: float | None = Field(default=None, ge=-50, le=250)

    humidity: float | None = Field(default=None, ge=0, le=100)

    gas_level: float | None = Field(default=None, ge=0, le=100000)

    flame_detected: bool = False

    scan_angle: float | None = Field(default=None, ge=0, le=360)

    hazard_detected: bool = False

    # optional extras the ESP32 can report for the Device health panel
    wifi_rssi: int | None = Field(default=None, ge=-120, le=0)

    uptime_s: int | None = Field(default=None, ge=0)


class HazardEvent(BaseModel):

    device_id: str = "alertnet01"

    event_type: str

    severity: str = "WARNING"

    temperature: float | None = None

    humidity: float | None = None

    gas_level: float | None = None

    scan_angle: float | None = None

    action_taken: str | None = None


class DeviceControl(BaseModel):

    pump: bool = False

    alarm: bool = False

    manual_override: bool = False

    target_angle: float = 0


DEFAULT_LIMITS = {
    "temperature_c": TEMPERATURE_THRESHOLD_C,
    "gas": GAS_THRESHOLD
}


class Limits(BaseModel):

    temperature_c: float = Field(ge=30, le=150)

    gas: float = Field(ge=50, le=10000)


def get_limits() -> dict:

    conn = get_connection()

    rows = conn.execute("SELECT key, value FROM settings").fetchall()

    conn.close()

    limits = dict(DEFAULT_LIMITS)

    for row in rows:
        if row["key"] in limits:
            limits[row["key"]] = row["value"]

    return limits


def calculate_system_status(
    temperature: float | None,
    gas_level: float | None,
    flame_detected: bool = False,
    hazard_detected: bool = False
) -> str:

    if flame_detected or hazard_detected:
        return "abnormal"

    limits = get_limits()

    if (
        temperature is not None and temperature >= limits["temperature_c"]
    ) or (
        gas_level is not None and gas_level >= limits["gas"]
    ):
        return "abnormal"

    if temperature is None or gas_level is None:
        return "unknown"

    return "normal"


# ============================================================
# BASIC SERVER TEST
# ============================================================

@app.get("/api/status")
def server_status():

    return {
        "system": "AlertNet",
        "status": "online",
        "thresholds": get_limits(),
        "auth_required": bool(API_KEY)
    }


# ============================================================
# SENSOR READINGS
# ============================================================

@app.post("/api/readings", dependencies=write_access)
def create_reading(reading: SensorReading):
    conn = get_connection()
    cursor = conn.execute("""
        INSERT INTO sensor_readings (
            device_id, temperature, humidity, gas_level,
            flame_detected, scan_angle, hazard_detected,
            wifi_rssi, uptime_s
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        reading.device_id, reading.temperature, reading.humidity,
        reading.gas_level, int(reading.flame_detected), reading.scan_angle,
        int(reading.hazard_detected), reading.wifi_rssi, reading.uptime_s
    ))
    conn.commit()

    # --- AUTOMATIC FLAME RESPONSE ---
    if reading.flame_detected:
        conn.execute("""
            UPDATE device_control 
            SET pump = 1, alarm = 1, updated_at = CURRENT_TIMESTAMP
            WHERE device_id = ?
        """, (reading.device_id,))
        conn.commit()

    reading_id = cursor.lastrowid
    conn.close()

    try:
        cleanup_old_data()
    except Exception as exc:
        print(f"Cleanup failed: {exc}")

    return {"message": "Sensor reading saved", "id": reading_id}


@app.get("/api/readings/history")
def get_reading_history(
    device_id: str = "alertnet01",
    minutes: int = 60,
    max_points: int = 300
):

    minutes = max(1, min(minutes, 10080))
    max_points = max(10, min(max_points, 1000))

    # Group readings into time buckets so long ranges stay small.
    # Temperature and gas keep the PEAK of each bucket so short spikes
    # never disappear from the chart; humidity is averaged.
    bucket_seconds = max(1, -(-minutes * 60 // max_points))

    conn = get_connection()

    rows = conn.execute("""
        SELECT
            MAX(created_at) AS created_at,
            MAX(temperature) AS temperature,
            ROUND(AVG(humidity), 1) AS humidity,
            MAX(gas_level) AS gas_level
        FROM sensor_readings
        WHERE device_id = ?
          AND created_at >= datetime('now', ?)
        GROUP BY CAST(strftime('%s', created_at) AS INTEGER) / ?
        ORDER BY MIN(id) ASC
    """, (device_id, f"-{minutes} minutes", bucket_seconds)).fetchall()

    conn.close()

    return [dict(row) for row in rows]


@app.get("/api/readings/latest")
def get_latest_reading(device_id: str = "alertnet01"):

    conn = get_connection()

    row = conn.execute("""
        SELECT *
        FROM sensor_readings
        WHERE device_id = ?
        ORDER BY id DESC
        LIMIT 1
    """, (device_id,)).fetchone()

    conn.close()


    if row is None:

        return {
            "message": "No sensor readings yet",
            "system_status": "unknown"
        }


    reading = dict(row)
    reading["system_status"] = calculate_system_status(
        reading["temperature"],
        reading["gas_level"],
        bool(reading["flame_detected"]),
        bool(reading["hazard_detected"])
    )

    return reading


# ============================================================
# HAZARD EVENTS
# ============================================================

@app.post("/api/events", dependencies=write_access)
def create_event(event: HazardEvent):

    conn = get_connection()

    cursor = conn.execute("""
        INSERT INTO hazard_events (
            device_id,
            event_type,
            severity,
            temperature,
            humidity,
            gas_level,
            scan_angle,
            action_taken
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        event.device_id,
        event.event_type,
        event.severity,
        event.temperature,
        event.humidity,
        event.gas_level,
        event.scan_angle,
        event.action_taken
    ))

    conn.commit()

    event_id = cursor.lastrowid

    conn.close()

    return {
        "message": "Hazard event saved",
        "id": event_id
    }


@app.get("/api/events/{device_id}")
def get_events(device_id: str, limit: int = 20):

    conn = get_connection()

    rows = conn.execute("""
        SELECT *
        FROM hazard_events
        WHERE device_id = ?
        ORDER BY id DESC
        LIMIT ?
    """, (device_id, max(1, min(limit, 500)))).fetchall()

    conn.close()

    return [dict(row) for row in rows]


# ============================================================
# DEVICE CONTROL
# ============================================================

@app.get("/api/control/{device_id}")
def get_device_control(device_id: str):

    conn = get_connection()

    row = conn.execute("""
        SELECT *
        FROM device_control
        WHERE device_id = ?
        LIMIT 1
    """, (device_id,)).fetchone()

    conn.close()


    if row is None:

        return {
            "device_id": device_id,
            "pump": False,
            "alarm": False,
            "manual_override": False,
            "target_angle": 0
        }


    return dict(row)


@app.post("/api/control/{device_id}", dependencies=write_access)
def update_device_control(
    device_id: str,
    control: DeviceControl
):

    conn = get_connection()

    conn.execute("""
        INSERT INTO device_control (
            device_id,
            pump,
            alarm,
            manual_override,
            target_angle,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)

        ON CONFLICT(device_id)
        DO UPDATE SET
            pump = excluded.pump,
            alarm = excluded.alarm,
            manual_override = excluded.manual_override,
            target_angle = excluded.target_angle,
            updated_at = CURRENT_TIMESTAMP
    """, (
        device_id,
        int(control.pump),
        int(control.alarm),
        int(control.manual_override),
        control.target_angle
    ))

    conn.commit()

    conn.close()

    return {
        "message": "Device control updated",
        "device_id": device_id
    }


# ============================================================
# DEVICE HEALTH
# ============================================================

OFFLINE_AFTER_SECONDS = 30


def iso_utc(epoch: int) -> str:

    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


@app.get("/api/health")
def device_health(device_id: str = "alertnet01"):

    conn = get_connection()

    last = conn.execute("""
        SELECT created_at, wifi_rssi, uptime_s,
               CAST(strftime('%s', created_at) AS INTEGER) AS t
        FROM sensor_readings
        WHERE device_id = ?
        ORDER BY id DESC
        LIMIT 1
    """, (device_id,)).fetchone()

    if last is None:
        conn.close()
        return {
            "device_id": device_id,
            "last_seen": None,
            "online": False,
            "offline_after_s": OFFLINE_AFTER_SECONDS
        }

    rows = conn.execute("""
        SELECT CAST(strftime('%s', created_at) AS INTEGER) AS t
        FROM sensor_readings
        WHERE device_id = ?
          AND created_at >= datetime('now', '-24 hours')
        ORDER BY created_at ASC
    """, (device_id,)).fetchall()

    conn.close()

    times = [row["t"] for row in rows] or [last["t"]]
    now = int(time.time())
    since_last = max(0, now - last["t"])
    online = since_last <= OFFLINE_AFTER_SECONDS

    # a gap longer than the offline limit counts as an outage
    outages = [
        (a, b) for a, b in zip(times, times[1:])
        if b - a > OFFLINE_AFTER_SECONDS
    ]
    normal_gaps = [
        b - a for a, b in zip(times, times[1:])
        if b - a <= OFFLINE_AFTER_SECONDS
    ]

    down_time = sum(b - a for a, b in outages) + (0 if online else since_last)
    span = now - times[0]

    last_outage = None
    if not online:
        last_outage = {"start": iso_utc(last["t"]), "end": None, "seconds": since_last}
    elif outages:
        a, b = outages[-1]
        last_outage = {"start": iso_utc(a), "end": iso_utc(b), "seconds": b - a}

    online_since = None
    if online:
        online_since = iso_utc(outages[-1][1] if outages else times[0])

    return {
        "device_id": device_id,
        "last_seen": last["created_at"],
        "online": online,
        "offline_after_s": OFFLINE_AFTER_SECONDS,
        "interval_s": round(sum(normal_gaps) / len(normal_gaps), 1) if normal_gaps else None,
        "online_since": online_since,
        "availability_pct": round(100 * (1 - down_time / span), 1) if span > 0 else None,
        "outages_24h": len(outages) + (0 if online else 1),
        "last_outage": last_outage,
        "wifi_rssi": last["wifi_rssi"],
        "uptime_s": last["uptime_s"]
    }


# ============================================================
# STORAGE INFO
# ============================================================

@app.get("/api/storage")
def storage_info():

    conn = get_connection()

    readings = conn.execute(
        "SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM sensor_readings"
    ).fetchone()

    events = conn.execute("SELECT COUNT(*) AS n FROM hazard_events").fetchone()

    conn.close()

    return {
        "readings": readings["n"],
        "oldest_reading": readings["oldest"],
        "events": events["n"],
        "readings_retention_days": READINGS_RETENTION_DAYS,
        "events_retention_days": EVENTS_RETENTION_DAYS,
        "db_bytes": DB_PATH.stat().st_size if DB_PATH.exists() else 0
    }


# ============================================================
# ACCESS CHECK
# ============================================================

@app.post("/api/auth/check", dependencies=write_access)
def check_access():

    return {"ok": True}


# ============================================================
# SETTINGS
# ============================================================

@app.get("/api/settings")
def read_settings():

    return get_limits()


@app.post("/api/settings", dependencies=write_access)
def update_settings(limits: Limits):

    conn = get_connection()

    for key, value in limits.model_dump().items():

        conn.execute("""
            INSERT INTO settings (key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """, (key, value))

    conn.commit()

    conn.close()

    return get_limits()


@app.post("/api/settings/reset", dependencies=write_access)
def reset_settings():

    conn = get_connection()

    conn.execute("DELETE FROM settings")

    conn.commit()

    conn.close()

    return get_limits()


# ============================================================
# WEB DASHBOARD
# ============================================================

WEB_FOLDER = Path(__file__).parent / "web"

if not WEB_FOLDER.is_dir():
    raise SystemExit(f"Dashboard folder not found: {WEB_FOLDER}\n"
                     "Put index.html, app.js and style.css inside a 'web' folder next to server.py.")

app.mount(
    "/",
    StaticFiles(
        directory=WEB_FOLDER,
        html=True
    ),
    name="web"
)


# ============================================================
# RUNNER
# ============================================================

def check_port_free(host: str, port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, port))
        except OSError:
            raise SystemExit(
                f"\nPort {port} is already in use - an old AlertNet server "
                f"is probably still running.\n"
                f"Stop it first (Windows: netstat -ano | findstr :{port}, "
                f"then taskkill /PID <pid> /F), or set a different PORT.\n"
            )


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    check_port_free(host, port)

    print(f"Starting AlertNet at http://{host}:{port}")
    uvicorn.run("server:app", host=host, port=port, reload=False)