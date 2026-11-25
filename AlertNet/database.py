import os
import sqlite3
from pathlib import Path


# Set DB_PATH to a persistent-disk location in production (e.g. /var/data/alertnet.db)
DB_PATH = Path(os.getenv("DB_PATH", Path(__file__).with_name("alertnet.db")))


def get_connection():

    conn = sqlite3.connect(DB_PATH)

    conn.row_factory = sqlite3.Row

    return conn


def init_db():

    conn = get_connection()


    # ========================================================
    # SENSOR READINGS
    # ========================================================

    conn.execute("""
        CREATE TABLE IF NOT EXISTS sensor_readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL DEFAULT 'alertnet01',
            temperature REAL,
            humidity REAL,
            gas_level REAL,
            flame_detected INTEGER NOT NULL DEFAULT 0,
            scan_angle REAL,
            hazard_detected INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    """)


    # ========================================================
    # HAZARD EVENTS
    # ========================================================

    conn.execute("""
        CREATE TABLE IF NOT EXISTS hazard_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL DEFAULT 'alertnet01',
            event_type TEXT NOT NULL,
            severity TEXT NOT NULL DEFAULT 'WARNING',
            temperature REAL,
            humidity REAL,
            gas_level REAL,
            scan_angle REAL,
            action_taken TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    """)


    # ========================================================
    # DEVICE CONTROL
    # ========================================================

    conn.execute("""
        CREATE TABLE IF NOT EXISTS device_control (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL UNIQUE,
            pump INTEGER NOT NULL DEFAULT 0,
            alarm INTEGER NOT NULL DEFAULT 0,
            manual_override INTEGER NOT NULL DEFAULT 0,
            target_angle REAL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    """)


    # Create default device control record

    conn.execute("""
        INSERT OR IGNORE INTO device_control (
            device_id,
            pump,
            alarm,
            manual_override,
            target_angle
        )
        VALUES (
            'alertnet01',
            0,
            0,
            0,
            0
        )
    """)



    # ========================================================
    # OPTIONAL DEVICE HEALTH COLUMNS (added to older databases too)
    # ========================================================

    existing = {row["name"] for row in conn.execute("PRAGMA table_info(sensor_readings)")}

    for column in ("wifi_rssi INTEGER", "uptime_s INTEGER"):
        if column.split()[0] not in existing:
            conn.execute(f"ALTER TABLE sensor_readings ADD COLUMN {column}")


    # ========================================================
    # INDEXES (keep history queries and cleanup fast as data grows)
    # ========================================================

    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_readings_device_created
        ON sensor_readings (device_id, created_at)
    """)

    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_events_device_created
        ON hazard_events (device_id, created_at)
    """)


    # ========================================================
    # SETTINGS (safety limits edited from the dashboard)
    # ========================================================

    conn.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value REAL NOT NULL
        )
    """)


    conn.commit()

    conn.close()