# AlertNet starter

A beginner-friendly FastAPI server and browser dashboard for the AlertNet prototype.

## Included readings
- Temperature (°C)
- Humidity (%)
- Gas level (raw sensor value)
- Scan angle (0–360°)
- Flame and hazard flags

## Run locally (Windows / VS Code)

Open this folder in VS Code, then run these commands in its terminal:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
uvicorn server:app --reload
```

If PowerShell blocks activation, you can skip activation and use:
```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn server:app --reload
```

Open:
- Dashboard: http://127.0.0.1:8000/
- API status: http://127.0.0.1:8000/api/status
- Interactive API docs: http://127.0.0.1:8000/docs

Use the dashboard's **Send test reading** button to save simulated data. The server stores it in `alertnet.db` locally.

## Deploy with GitHub + Render

1. Create a new GitHub repository named `AlertNet`.
2. Upload/commit the contents of this folder to the repository root (not the outer ZIP folder).
3. In Render, create a new **Web Service** and connect the repository.
4. Use build command `pip install -r requirements.txt`.
5. Use start command `uvicorn server:app --host 0.0.0.0 --port $PORT`.
6. Deploy, then visit `/api/status` and `/docs` on the Render URL.

`render.yaml` contains the same basic service settings if you choose Render Blueprint deployment.

## Database note

SQLite is used for local development. A SQLite file on a typical Render web service's ephemeral filesystem is not durable across all restarts/redeployments. Before depending on online sensor history, migrate to a persistent database such as managed PostgreSQL (for example, Supabase Postgres) or configure a suitable persistent disk.

## Important safety note

This is a software prototype, not a certified fire detection or suppression system. Simulated readings do not represent real sensors, and saving a control request does not confirm physical hardware operation.
