const DEVICE_ID = "alertnet01";
let refreshMs = 500;
let refreshTimer;
const STALE_AFTER_S = 30;
const COLORS = { ok: "#34d399", warn: "#fbbf24", danger: "#f43f5e", calm: "#2f9bff" };

let limits = { temperature_c: 58, gas: 750 };
let state = { online: false, reading: null, control: null, history: [], events: [] };
let rangeMinutes = 60;
let shownAngle = 0;

const $ = (id) => document.getElementById(id);
const has = (v) => v !== null && v !== undefined;
const fmt = (v, d = 0) => (has(v) ? Number(v).toFixed(d) : null);


// ---------- helpers ----------

// SQLite CURRENT_TIMESTAMP is UTC without a timezone marker
function parseTime(ts) {
    if (!ts) return null;
    const iso = /Z|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(" ", "T") + "Z";
    const d = new Date(iso);
    return isNaN(d) ? null : d;
}
const formatTime = (ts) => {
    const d = parseTime(ts);
    return d ? d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "--";
};
const ageSeconds = (ts) => {
    const d = parseTime(ts);
    return d ? Math.max(0, Math.round((Date.now() - d.getTime()) / 1000)) : null;
};
function ago(s) {
    if (s === null) return "--";
    if (s < 5) return "just now";
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
}
const escapeHTML = (v) => String(v)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

// Replace the existing unitValue function with this one
const lastValue = {};
function unitValue(el, v, unit, digits) {
    const t = fmt(v, digits);
    const id = el.id;
    const changed = lastValue[id] !== t;
    lastValue[id] = t;
    el.innerHTML = t === null ? "--" : `${t}<small>${unit}</small>`;
    if (changed && t !== null) {
        el.classList.remove("flash");
        void el.offsetWidth;      // Force browser to restart animation
        el.classList.add("flash");
    }
}
const sevKey = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

// ---------- loading overlay ----------
const loaderEl = $("loader");
const loaderBar = $("loaderBar");
const loaderPct = $("loaderPct");
const loaderStatus = $("loaderStatus");

let loaderProgress = 0;
let loaderDone = false;

function setProgress(pct, label) {
    // only move forward so the bar never jumps back
    if (pct < loaderProgress) return;
    loaderProgress = Math.min(100, Math.round(pct));
    if (loaderBar) loaderBar.style.width = `${loaderProgress}%`;
    if (loaderPct) loaderPct.textContent = `${loaderProgress}%`;
    if (label && loaderStatus) loaderStatus.textContent = label;
}

// smooth trickle while real work happens
const trickle = setInterval(() => {
    if (loaderProgress < 90) setProgress(loaderProgress + Math.random() * 1.5);
}, 400);

function stopTrickle() { clearInterval(trickle); }

function hideLoader() {
    if (loaderDone || !loaderEl) return;
    loaderDone = true;
    setProgress(100, "Ready");
    
    // Wait for the progress bar to finish filling smoothly before fading out
    setTimeout(() => {
        loaderEl.classList.add("is-hidden");
        setTimeout(() => loaderEl.remove(), 700);
    }, 1000); // <--- Increased delay so you can see the "Ready" state
}


// ---------- data loading ----------

async function getJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return res.json();
}

async function loadLimits() {
    try {
        const s = await getJSON("/api/status");
        if (s.thresholds) limits = s.thresholds;
        state.authRequired = !!s.auth_required;
    } catch (e) { /* keep defaults */ }
}
async function loadLatest() {
    try {
        const d = await getJSON("/api/readings/latest");
        state.online = true;
        state.reading = d.message ? null : d;
    } catch (e) { console.error(e); state.online = false; }
}
const loadControl = async () => { try { state.control = await getJSON(`/api/control/${DEVICE_ID}`); } catch (e) { console.error(e); } };
const loadHistory = async () => {
    try { state.history = await getJSON(`/api/readings/history?device_id=${DEVICE_ID}&minutes=${rangeMinutes}&max_points=300`); }
    catch (e) { console.error(e); }
};
const loadEvents = async () => { try { state.events = await getJSON(`/api/events/${DEVICE_ID}?limit=200`); } catch (e) { console.error(e); } };


// ---------- charts ----------

// smooth curve through points with no overshoot
function smoothPath(p) {
    let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
    for (let i = 1; i < p.length; i++) {
        const [x0, y0] = p[i - 1], [x1, y1] = p[i], mx = ((x0 + x1) / 2).toFixed(1);
        d += ` C${mx} ${y0.toFixed(1)} ${mx} ${y1.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    }
    return d;
}

const gradient = (id, color, top) =>
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="${top}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>`;

function sparkline(svgId, values, color) {
    const svg = $(svgId);
    const v = values.filter(has).slice(-40);
    if (v.length < 2) { svg.innerHTML = ""; return; }
    const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
    const pts = v.map((y, i) => [(i / (v.length - 1)) * 100, 32 - ((y - lo) / span) * 28]);
    const line = smoothPath(pts);
    svg.innerHTML = gradient(`g-${svgId}`, color, ".4") +
        `<path d="${line} L100 36 L0 36 Z" fill="url(#g-${svgId})"/>` +
        `<path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
}

function lineChart(elId, statsId, rows, key, limit, unit, digits, color = COLORS.calm) {
    const el = $(elId);
    const pts = rows.map((r) => ({ t: parseTime(r.created_at), v: r[key] })).filter((p) => p.t && has(p.v));
    if (!pts.length) {
        el.innerHTML = `<p class="empty">No readings in this period.</p>`;
        $(statsId).textContent = "";
        return;
    }
    const vals = pts.map((p) => p.v);
    const min = Math.min(...vals), max = Math.max(...vals), avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    $(statsId).innerHTML = `Min <b>${min.toFixed(digits)}</b>  Avg <b>${avg.toFixed(digits)}</b>  Max <b>${max.toFixed(digits)}</b> ${unit}`;

    const W = Math.max(280, el.clientWidth - 20), H = 220;
    const m = { l: 42, r: 10, t: 12, b: 26 };
    const hi = Math.max(max, limit * 1.05);
    const lo = Math.max(0, Math.min(min, limit) - (hi - Math.min(min, limit)) * 0.2);
    const t1 = Date.now(), t0 = t1 - rangeMinutes * 60000;
    const x = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo || 1)) * (H - m.t - m.b);

    let grid = "";
    for (let i = 0; i <= 4; i++) {
        const v = lo + ((hi - lo) * i) / 4, yy = y(v);
        grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}" stroke="#22304a"/>` +
                `<text x="${m.l - 6}" y="${yy + 4}" text-anchor="end" fill="#8b9ab3" font-size="11">${v.toFixed(hi > 20 ? 0 : 1)}</text>`;
    }
    for (let i = 0; i <= 3; i++) {
        const t = t0 + ((t1 - t0) * i) / 3;
        const anchor = i === 0 ? "start" : i === 3 ? "end" : "middle";
        const label = new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        grid += `<text x="${x(t)}" y="${H - 6}" text-anchor="${anchor}" fill="#8b9ab3" font-size="11">${label}</text>`;
    }

    const d = smoothPath(pts.map((p) => [x(p.t), y(p.v)]));
    const last = pts[pts.length - 1];
    const ly = y(limit);
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${key} trend">
        ${gradient(`g-${elId}`, color, ".28")}
        ${grid}
        <line x1="${m.l}" x2="${W - m.r}" y1="${ly}" y2="${ly}" stroke="${COLORS.danger}" stroke-dasharray="5 4"/>
        <text x="${W - m.r}" y="${ly - 5}" text-anchor="end" fill="${COLORS.danger}" font-size="11">Limit ${limit}</text>
        <path d="${d} L${x(last.t).toFixed(1)} ${H - m.b} L${x(pts[0].t).toFixed(1)} ${H - m.b} Z" fill="url(#g-${elId})"/>
        <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
        <circle cx="${x(last.t)}" cy="${y(last.v)}" r="4" fill="${last.v >= limit ? COLORS.danger : color}"/>
    </svg>`;
}


// ---------- rendering ----------

function setBanner(kind, title, detail, icon) {
    handleAlert(kind === "danger", detail);
    $("systemStatus").dataset.state = kind;
    $("statusText").textContent = title;
    $("statusDetail").textContent = detail;
    $("statusIcon").textContent = icon;
}
function renderConnection(kind) {
    $("connection").dataset.state = kind;
    $("connectionText").textContent =
        { live: "Live", idle: "No device yet", stale: "No recent data", offline: "Server unreachable" }[kind] || "Connecting";
}
function levelOf(value, limit) {
    return !has(value) ? "" : value >= limit ? "danger" : value >= limit * 0.8 ? "warn" : "";
}
function hazardReasons(r) {
    const out = [];
    if (has(r.temperature) && r.temperature >= limits.temperature_c)
        out.push(`temperature ${fmt(r.temperature, 1)} °C is over the ${limits.temperature_c} °C limit`);
    if (has(r.gas_level) && r.gas_level >= limits.gas)
        out.push(`gas level ${fmt(r.gas_level)} is over the ${limits.gas} limit`);
    if (r.flame_detected) out.push("flame detected");
    if (!out.length && r.hazard_detected) out.push("device reported a hazard");
    const t = out.join(", ");
    return t.charAt(0).toUpperCase() + t.slice(1) + ".";
}

function renderBadges() {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const counts = {};
    state.events.forEach((e) => {
        const d = parseTime(e.created_at);
        if (d && d.getTime() >= cutoff) counts[sevKey(e.severity)] = (counts[sevKey(e.severity)] || 0) + 1;
    });
    const order = ["critical", "high", "medium", "warning"];
    const html = order.filter((k) => counts[k]).map((k) => `<span class="badge ${k}">${counts[k]} ${k}</span>`).join("");
    $("alarmBadges").innerHTML = html ? `<span class="stats">Last 24 h</span>${html}` : "";
}

function renderStatus() {
    const r = state.reading;
    const age = r ? ageSeconds(r.created_at) : null;
    const stale = age !== null && age > STALE_AFTER_S;

    if (!state.online) {
        renderConnection("offline");
        setBanner("unknown", "Can't reach the server", "Check your connection. This page keeps retrying.", "?");
    } else if (!r) {
        renderConnection("idle");
        setBanner("idle", "No device connected", "Live readings will appear once your device starts sending data.", "–");
    } else if (stale) {
        renderConnection("stale");
        setBanner("unknown", "No recent data", `Last reading was ${ago(age)}. Check the device's power and Wi-Fi.`, "?");
    } else if (r.system_status === "abnormal") {
        renderConnection("live");
        setBanner("danger", "Hazard detected", hazardReasons(r), "!");
    } else if (r.system_status === "normal") {
        renderConnection("live");
        setBanner("normal", "System normal", "All readings are within safe limits.", "✓");
    } else {
        renderConnection("live");
        setBanner("unknown", "Status unknown", "Some sensor values are missing.", "?");
    }
    $("lastUpdate").textContent = ago(age);
    $("setupCard").hidden = !(state.online && !r);
    document.body.classList.toggle("no-data", !r);
}

function renderTiles() {
    const r = state.reading;
    const col = (lvl) => lvl === "danger" ? COLORS.danger : lvl === "warn" ? COLORS.warn : COLORS.ok;
    $("tempNote").textContent = `Limit ${limits.temperature_c} °C`;
    $("gasNote").textContent = `Limit ${limits.gas}`;

    if (r) {
        const tl = levelOf(r.temperature, limits.temperature_c), gl = levelOf(r.gas_level, limits.gas);
        unitValue($("temperature"), r.temperature, "°C", 1);
        unitValue($("humidity"), r.humidity, "%", 1);
        $("gasLevel").textContent = fmt(r.gas_level) ?? "--";
        unitValue($("bigTemp"), r.temperature, "°C", 1);
        $("bigGas").textContent = fmt(r.gas_level) ?? "--";
        $("flameStatus").textContent = r.flame_detected ? "Detected" : "None";
        $("tempCard").dataset.level = tl;
        $("gasCard").dataset.level = gl;
        $("flameCard").dataset.level = r.flame_detected ? "danger" : "";
        const hazardText = r.system_status === "abnormal" ? "Hazard detected" : r.system_status === "normal" ? "None" : "Unknown";
        const readingAge = ageSeconds(r.created_at);
        const isStale = readingAge !== null && readingAge > STALE_AFTER_S;
        $("hazardStatus").textContent = isStale ? `${hazardText} (last reading)` : hazardText;
        $("deviceId").textContent = r.device_id || DEVICE_ID;
        $("footerDevice").textContent = r.device_id || DEVICE_ID;
        $("scannerAngle").textContent = has(r.scan_angle) ? `${fmt(r.scan_angle)}°` : "--°";
        moveSweep(r.scan_angle);
        sparkline("sparkTemp", state.history.map((h) => h.temperature), col(tl));
        sparkline("sparkGas", state.history.map((h) => h.gas_level), col(gl));
        sparkline("sparkHum", state.history.map((h) => h.humidity), COLORS.calm);
    }
}

function renderControl() {
    const c = state.control;
    if (!c) return;
    const chip = (id, text, on) => { const el = $(id); el.textContent = text; el.dataset.on = on; };
    chip("pumpStatus", c.pump ? "On" : "Off", !!c.pump);
    chip("alarmStatus", c.alarm ? "On" : "Off", !!c.alarm);
    const mode = $("modeStatus");
    mode.textContent = c.manual_override ? "Manual" : "Automatic";
    mode.dataset.tone = c.manual_override ? "manual" : "";
    $("targetAngle").textContent = has(c.target_angle) ? `${fmt(c.target_angle)}°` : "--°";
    const t = $("targetMarker");
    t.hidden = !c.manual_override;
    if (c.manual_override && has(c.target_angle)) t.style.transform = `rotate(${Number(c.target_angle)}deg)`;
}

// rotate the short way round so 350° -> 10° doesn't spin backwards
function moveSweep(angle) {
    if (!has(angle)) return;
    shownAngle += ((((Number(angle) - shownAngle) % 360) + 540) % 360) - 180;
    $("scannerLine").style.transform = `rotate(${shownAngle}deg)`;
}

function renderCharts() {
    lineChart("chartTemp", "statsTemp", state.history, "temperature", limits.temperature_c, "°C", 1, "#a78bfa");
    lineChart("chartGas", "statsGas", state.history, "gas_level", limits.gas, "", 0, "#fb923c");
}

function filteredEvents() {
    const sev = $("severityFilter").value, q = $("eventSearch").value.trim().toLowerCase();
    return state.events.filter((e) =>
        (sev === "all" || sevKey(e.severity) === sev) &&
        (!q || [e.event_type, e.severity, e.action_taken].some((v) => String(v ?? "").toLowerCase().includes(q))));
}

function downloadCSV() {
    const cell = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const head = ["Time (UTC)", "Event", "Severity", "Temperature C", "Humidity %", "Gas", "Angle", "Action taken"];
    const lines = filteredEvents().map((e) => {
        const d = parseTime(e.created_at);
        return [d ? d.toISOString() : "", e.event_type, e.severity, e.temperature, e.humidity, e.gas_level, e.scan_angle, e.action_taken].map(cell).join(",");
    });
    const blob = new Blob([[head.map(cell).join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `alertnet-events-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
}

function renderEvents() {
    const body = $("eventTable");
    const rows = filteredEvents().slice(0, 100);

    if (!rows.length) {
        body.innerHTML = `<tr class="empty"><td colspan="8">${
            state.events.length ? "No events match these filters." : "No hazard events yet. They will appear here when the device reports one."}</td></tr>`;
        return;
    }
    body.innerHTML = rows.map((e) => {
        const sev = sevKey(e.severity);
        return `<tr>
            <td data-label="Priority"><span class="pri sev-${sev}"></span></td>
            <td data-label="Time">${formatTime(e.created_at)}</td>
            <td data-label="Event">${escapeHTML(e.event_type)}</td>
            <td data-label="Severity"><span class="sev sev-${sev}">${escapeHTML(e.severity)}</span></td>
            <td data-label="Temp">${has(e.temperature) ? fmt(e.temperature, 1) + " °C" : "--"}</td>
            <td data-label="Gas">${has(e.gas_level) ? fmt(e.gas_level) : "--"}</td>
            <td data-label="Angle">${has(e.scan_angle) ? fmt(e.scan_angle) + "°" : "--"}</td>
            <td data-label="Action taken">${escapeHTML(e.action_taken ?? "--")}</td>
        </tr>`;
    }).join("");
}

function renderAll() {
    renderStatus(); renderTiles(); renderControl(); renderCharts(); renderBadges(); renderEvents(); syncControlForm();
}


// ---------- loop ----------

async function refresh() {
    clearTimeout(refreshTimer);
    await Promise.all([loadLatest(), loadControl(), loadHistory(), loadEvents()]);
    renderAll();
    loadHealth();
    clearTimeout(refreshTimer);
    if (refreshMs > 0) refreshTimer = setTimeout(refresh, refreshMs);
}

$("rangeSelect").addEventListener("change", async (e) => {
    rangeMinutes = Number(e.target.value);
    await loadHistory();
    renderTiles(); renderCharts();
});
$("severityFilter").addEventListener("change", renderEvents);
$("eventSearch").addEventListener("input", renderEvents);
$("csvBtn").addEventListener("click", downloadCSV);

$("autoSelect").addEventListener("change", (e) => {
    refreshMs = Number(e.target.value);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, refreshMs);
});

$("refreshBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.classList.add("spinning");
    await refresh();
    btn.classList.remove("spinning");
});

// ---------- access key ----------

let apiKey = "";
try { apiKey = localStorage.getItem("alertnet_key") || ""; } catch (e) { /* storage unavailable */ }

const keyDialog = $("keyDialog");
const isLocked = () => !!state.authRequired && !apiKey;

function saveKey(key) {
    apiKey = key;
    try {
        if (key) localStorage.setItem("alertnet_key", key);
        else localStorage.removeItem("alertnet_key");
    } catch (e) { /* storage unavailable */ }
}

async function postJSON(url, payload) {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["X-API-Key"] = apiKey;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload ?? {}) });
    if (res.status === 401) {
        saveKey("");
        applyLock();
        openKeyDialog();
        throw new Error("locked");
    }
    return res;
}

async function verifyStoredKey() {
    if (!state.authRequired || !apiKey) return;
    try {
        const res = await fetch("/api/auth/check", { method: "POST", headers: { "X-API-Key": apiKey } });
        if (res.status === 401) saveKey("");
    } catch (e) { /* keep the key, server may be restarting */ }
}

function applyLock() {
    const locked = isLocked();
    document.querySelectorAll(".lock-note").forEach((n) => { n.hidden = !locked; });
    const btn = $("lockBtn");
    btn.hidden = !state.authRequired;
    btn.dataset.state = locked ? "locked" : "open";
    btn.title = locked ? "Enter the access key to unlock" : "Click to lock";
    $("lockText").textContent = locked ? "Locked" : "Unlocked";
    ["ctlSend", "ctlReset", "setTemp", "setGas", "setSave", "setReset"].forEach((id) => { $(id).disabled = locked; });
    syncControlForm();
}

function openKeyDialog() {
    $("keyMsg").textContent = "";
    if (typeof keyDialog.showModal === "function") { if (!keyDialog.open) keyDialog.showModal(); }
    else keyDialog.setAttribute("open", "");
    $("keyInput").focus();
}

function closeKeyDialog() {
    if (typeof keyDialog.close === "function") keyDialog.close();
    else keyDialog.removeAttribute("open");
}

$("lockBtn").addEventListener("click", () => {
    if (isLocked()) openKeyDialog();
    else { saveKey(""); applyLock(); }
});
document.addEventListener("click", (e) => { if (e.target.closest(".unlock-link")) openKeyDialog(); });
$("keyCancel").addEventListener("click", closeKeyDialog);

$("keyForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = $("keyInput").value.trim();
    if (!key) return;
    $("keyMsg").textContent = "Checking...";
    try {
        const res = await fetch("/api/auth/check", { method: "POST", headers: { "X-API-Key": key } });
        if (res.status === 401) { $("keyMsg").textContent = "That key isn't right."; return; }
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        saveKey(key);
        $("keyInput").value = "";
        closeKeyDialog();
        applyLock();
    } catch (err) {
        $("keyMsg").textContent = "Couldn't reach the server. Try again.";
    }
});


// ---------- manual control ----------

let ctlDirty = false;
const ctl = { manual: $("ctlManual"), pump: $("ctlPump"), alarm: $("ctlAlarm"), angle: $("ctlAngle") };

function syncControlForm() {
    const c = state.control;
    if (c && !ctlDirty) {
        ctl.manual.checked = !!c.manual_override;
        ctl.pump.checked = !!c.pump;
        ctl.alarm.checked = !!c.alarm;
        ctl.angle.value = Math.round(c.target_angle ?? 0);
    }
    const manual = ctl.manual.checked;
    ctl.manual.disabled = isLocked();
    [ctl.pump, ctl.alarm, ctl.angle].forEach((el) => { el.disabled = !manual || isLocked(); });
    $("ctlAngleOut").textContent = `${ctl.angle.value}°`;
    $("ctlState").textContent = c ? (c.manual_override ? "Manual control is on" : "Device is in automatic mode") : "";
}

async function sendControl(payload, okMessage) {
    const buttons = [$("ctlSend"), $("ctlReset")], msg = $("ctlMsg");
    buttons.forEach((b) => { b.disabled = true; });
    msg.textContent = "Sending...";
    try {
        const res = await postJSON(`/api/control/${DEVICE_ID}`, payload);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        ctlDirty = false;
        state.control = { ...state.control, ...payload };
        msg.textContent = okMessage;
        renderAll();
    } catch (e) {
        console.error(e);
        msg.textContent = e.message === "locked" ? "Locked. Enter the access key to make changes." : "Couldn't send. Check the connection and try again.";
    } finally {
        buttons.forEach((b) => { b.disabled = false; });
        applyLock();
    }
}

[ctl.manual, ctl.pump, ctl.alarm, ctl.angle].forEach((el) =>
    el.addEventListener("input", () => { ctlDirty = true; $("ctlMsg").textContent = ""; syncControlForm(); }));

$("ctlSend").addEventListener("click", () => {
    const manual = ctl.manual.checked;
    const payload = {
        manual_override: manual,
        pump: manual && ctl.pump.checked,
        alarm: manual && ctl.alarm.checked,
        target_angle: Number(ctl.angle.value),
    };
    if (payload.pump && !state.control?.pump && !confirm("Turn the water pump on?")) return;
    sendControl(payload, "Sent. The device applies this on its next check.");
});

$("ctlReset").addEventListener("click", () => {
    ctl.manual.checked = ctl.pump.checked = ctl.alarm.checked = false;
    sendControl({ manual_override: false, pump: false, alarm: false, target_angle: Number(ctl.angle.value) },
                "Device is back in automatic mode.");
});


// ---------- device setup card ----------

const POST_URL = `${location.origin}/api/readings`;
$("setupUrl").textContent = `POST ${POST_URL}`;
$("copyUrl").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    try {
        await navigator.clipboard.writeText(POST_URL);
        btn.textContent = "Copied";
    } catch (err) {
        btn.textContent = "Copy failed";
    }
    setTimeout(() => { btn.textContent = "Copy address"; }, 1500);
});


// ---------- settings ----------

let setDirty = false;

function syncSettingsForm() {
    if (!setDirty) {
        $("setTemp").value = limits.temperature_c;
        $("setGas").value = limits.gas;
    }
    $("setDevice").textContent = DEVICE_ID;
    $("setUrl").textContent = POST_URL;
    $("setAuth").textContent = state.authRequired ? "Required for changes" : "Not set. Anyone can make changes";
}

async function loadStorage() {
    try {
        const s = await getJSON("/api/storage");
        const days = (n) => (n > 0 ? `${n} day${n === 1 ? "" : "s"}` : "Forever");
        $("stReadings").textContent = s.readings.toLocaleString();
        $("stOldest").textContent = s.oldest_reading ? formatTime(s.oldest_reading) : "No readings yet";
        $("stKeep").textContent = days(s.readings_retention_days);
        $("stEvKeep").textContent = days(s.events_retention_days);
        $("stSize").textContent = s.db_bytes >= 1048576
            ? `${(s.db_bytes / 1048576).toFixed(1)} MB`
            : `${Math.max(1, Math.round(s.db_bytes / 1024))} KB`;
    } catch (e) { console.error(e); }
}

async function sendSettings(url, payload, okMessage) {
    const msg = $("setMsg"), buttons = [$("setSave"), $("setReset")];
    buttons.forEach((b) => { b.disabled = true; });
    msg.textContent = "Saving...";
    try {
        const res = await postJSON(url, payload);
        if (res.status === 422) throw new Error("range");
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        limits = await res.json();
        setDirty = false;
        syncSettingsForm();
        msg.textContent = okMessage;
        await refresh();
    } catch (e) {
        console.error(e);
        msg.textContent = e.message === "range"
            ? "Those values are out of range. Temperature must be 30 to 150 and gas 50 to 10000."
            : e.message === "locked" ? "Locked. Enter the access key to make changes."
            : "Couldn't save. Check the connection and try again.";
    } finally {
        buttons.forEach((b) => { b.disabled = false; });
        applyLock();
    }
}

["setTemp", "setGas"].forEach((id) => $(id).addEventListener("input", () => { setDirty = true; $("setMsg").textContent = ""; }));

$("settingsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    sendSettings("/api/settings", { temperature_c: Number($("setTemp").value), gas: Number($("setGas").value) }, "Limits saved.");
});

$("setReset").addEventListener("click", () => {
    if (confirm("Restore the default safety limits?")) sendSettings("/api/settings/reset", {}, "Defaults restored.");
});


// ---------- hazard alerts ----------

let alertsOn = false;
let audioCtx = null;
let baseTitle = "AlertNet";
const alertState = { active: false, timer: null, repeats: 0, silenced: false };
const SIREN_EVERY_MS = 3000, SIREN_MAX_REPEATS = 20;

try { alertsOn = localStorage.getItem("alertnet_alerts") === "1"; } catch (e) { /* storage unavailable */ }

function updateTitle() {
    document.title = alertState.active ? `(!) Hazard | ${baseTitle}` : baseTitle;
}

function initAudio() {
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!audioCtx) audioCtx = new AC();
        if (audioCtx.state === "suspended") audioCtx.resume().then(renderAlertUI);
    } catch (e) { /* audio unavailable */ }
    renderAlertUI();
}

function beep() {
    if (!audioCtx || audioCtx.state !== "running") return;
    const t = audioCtx.currentTime;
    [880, 660, 880].forEach((freq, i) => {
        const osc = audioCtx.createOscillator(), gain = audioCtx.createGain(), at = t + i * 0.25;
        osc.type = "square";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(at);
        osc.stop(at + 0.24);
    });
}

function notify(title, body, sticky = false) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
        const n = new Notification(title, { body, tag: "alertnet-hazard", requireInteraction: sticky });
        n.onclick = () => { window.focus(); n.close(); };
    } catch (e) { /* some mobile browsers only allow notifications through a service worker */ }
}

function stopSiren() {
    clearInterval(alertState.timer);
    alertState.timer = null;
}

function startSiren() {
    stopSiren();
    const tick = () => {
        if (alertState.silenced || !alertsOn || alertState.repeats++ >= SIREN_MAX_REPEATS) { stopSiren(); return; }
        beep();
    };
    tick();
    if (alertState.repeats < SIREN_MAX_REPEATS && !alertState.silenced && alertsOn) {
        alertState.timer = setInterval(tick, SIREN_EVERY_MS);
    }
}

// called on every render; only acts when a hazard starts or ends
function handleAlert(isDanger, detail) {
    if (isDanger && !alertState.active) {
        alertState.active = true;
        alertState.silenced = false;
        alertState.repeats = 0;
        if (alertsOn) {
            notify("AlertNet: hazard detected", detail, true);
            startSiren();
        }
    } else if (!isDanger && alertState.active) {
        alertState.active = false;
        stopSiren();
    }
    updateTitle();
    $("silenceBtn").hidden = !(alertState.active && alertsOn && alertState.timer !== null);
}

function setAlerts(on) {
    alertsOn = on;
    try { localStorage.setItem("alertnet_alerts", on ? "1" : "0"); } catch (e) { /* storage unavailable */ }
    if (on && alertState.active) { alertState.silenced = false; alertState.repeats = 0; startSiren(); }
    if (!on) stopSiren();
    renderAlertUI();
    $("silenceBtn").hidden = !(alertState.active && alertsOn && alertState.timer !== null);
}

async function enableAlerts() {
    initAudio();
    if ("Notification" in window && Notification.permission === "default") {
        try { await Notification.requestPermission(); } catch (e) { /* ignore */ }
    }
    setAlerts(true);
}

function renderAlertUI() {
    const btn = $("alertBtn");
    btn.dataset.state = alertsOn ? "open" : "off";
    btn.setAttribute("aria-pressed", String(alertsOn));
    $("alertText").textContent = alertsOn ? "Alerts on" : "Alerts off";

    let status;
    if (!alertsOn) {
        status = "Off. Use the Alerts button at the top to turn them on.";
    } else {
        const perm = "Notification" in window ? Notification.permission : "unsupported";
        const notes = perm === "granted" ? "sound and notifications"
            : perm === "denied" ? "sound only (notifications are blocked in this browser)"
            : perm === "unsupported" ? "sound only (notifications aren't supported here)"
            : "sound only (notification permission not given)";
        const audioReady = audioCtx && audioCtx.state === "running";
        status = `On: ${notes}.${audioReady ? "" : " Click anywhere on the page to activate sound."}`;
    }
    $("alertStatus").textContent = status;
}

$("alertBtn").addEventListener("click", () => { if (alertsOn) setAlerts(false); else enableAlerts(); });

$("silenceBtn").addEventListener("click", () => {
    alertState.silenced = true;
    stopSiren();
    $("silenceBtn").hidden = true;
});

$("alertTest").addEventListener("click", async () => {
    await enableAlerts();
    beep();
    notify("AlertNet test", "Alerts are working.");
});

// browsers only allow sound after the person has interacted with the page
["pointerdown", "keydown"].forEach((type) =>
    document.addEventListener(type, () => { if (alertsOn) initAudio(); }, { passive: true }));

renderAlertUI();


// ---------- device health ----------

let healthAt = 0;

function duration(seconds) {
    if (seconds === null || seconds === undefined) return "--";
    const s = Math.round(seconds);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
    const d = Math.floor(h / 24);
    return `${d} d${h % 24 ? ` ${h % 24} h` : ""}`;
}

function signalLabel(rssi) {
    return rssi >= -60 ? "Excellent" : rssi >= -70 ? "Good" : rssi >= -80 ? "Fair" : "Weak";
}

// the server does the heavy counting, so ask at most every 15 seconds
async function loadHealth(force = false) {
    if (!force && Date.now() - healthAt < 15000) return;
    healthAt = Date.now();
    try {
        state.health = await getJSON(`/api/health?device_id=${DEVICE_ID}`);
        renderHealth();
    } catch (e) { console.error(e); }
}

function renderHealth() {
    const hth = state.health;
    if (!hth) return;

    const set = (id, text) => { $(id).textContent = text; };
    const none = "--";

    if (!hth.last_seen) {
        $("hStatus").innerHTML = `<i class="hdot"></i>No data yet`;
        ["hSeen", "hInterval", "hSince", "hAvail", "hOutages", "hRssi", "hUptime"].forEach((id) => set(id, none));
        set("hLast", "The device hasn't reported yet.");
        return;
    }

    const age = ageSeconds(hth.last_seen);
    const online = age !== null && age <= (hth.offline_after_s || 30);

    $("hStatus").innerHTML = `<i class="hdot" data-state="${online ? "ok" : "bad"}"></i>${online ? "Online" : "Offline"}`;
    set("hSeen", ago(age));
    set("hInterval", hth.interval_s ? `${hth.interval_s} s` : none);
    set("hSince", online && hth.online_since ? duration(ageSeconds(hth.online_since)) : none);
    set("hAvail", has(hth.availability_pct) ? `${hth.availability_pct}%` : none);
    set("hOutages", String(hth.outages_24h ?? 0));
    set("hRssi", has(hth.wifi_rssi) ? `${hth.wifi_rssi} dBm (${signalLabel(hth.wifi_rssi)})` : "Not reported");
    set("hUptime", has(hth.uptime_s) ? duration(hth.uptime_s + (online ? age : 0)) : "Not reported");

    const lo = hth.last_outage;
    set("hLast", !lo ? "No outages in the last 24 hours."
        : !lo.end ? `Current outage: no data for ${duration(age)}.`
        : `Last outage: ${duration(lo.seconds)}, ended ${ago(ageSeconds(lo.end))}.`);
}


// ---------- menu views ----------

const VIEWS = { overview: "Overview", trends: "Trends", controls: "Controls", history: "Alarm history", settings: "Settings" };
const navLinks = [...document.querySelectorAll(".nav a")];

function showView() {
    const key = location.hash.slice(1);
    const name = VIEWS[key] ? key : "overview";
    document.querySelectorAll(".view").forEach((v) => { v.hidden = v.dataset.view !== name; });
    navLinks.forEach((a) => a.setAttribute("aria-current", String(a.hash === `#${name}`)));
    $("viewTitle").textContent = VIEWS[name];
    baseTitle = `${VIEWS[name]} | AlertNet`;
    updateTitle();
    document.body.dataset.page = name;
    window.scrollTo(0, 0);
    if (name === "settings") { syncSettingsForm(); loadStorage(); }
    if (name === "overview") loadHealth(true);
    renderCharts();   // charts measure their width, so redraw once visible
}
window.addEventListener("hashchange", showView);
showView();

let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderCharts, 150); });

// keep "x s ago" and the stale check ticking between fetches
setInterval(() => { renderStatus(); renderHealth(); }, 1000);

// progress step helpers
async function step(pct, label, fn) {
    setProgress(pct, label);
    try { return await fn(); } catch (e) { console.error(e); }
}

// Add a delay helper to force the animation to be visible
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    setProgress(8, "Connecting to server…");
    await delay(600); // Wait 0.6s
    
    await step(20, "Loading safety limits…", loadLimits);
    await delay(700);

    await step(38, "Checking access…", verifyStoredKey);
    await delay(500);

    setProgress(55, "Fetching latest reading…");
    await step(65, "Fetching device status…", loadLatest);
    await delay(600);

    await step(75, "Fetching controls…", loadControl);
    await delay(400);

    await step(85, "Loading history…", loadHistory);
    await delay(700);

    await step(92, "Loading events…", loadEvents);
    await delay(800);

    // Render everything now that data is loaded
    applyLock();
    syncSettingsForm();
    renderAll();
    loadHealth();

    stopTrickle();
    
    // The hideLoader function already has a 1-second built-in pause
    hideLoader();

    // normal refresh loop from here on
    refreshTimer = setTimeout(refresh, refreshMs);
})();