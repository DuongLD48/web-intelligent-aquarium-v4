// ================================================================
// dashboard.js — Intelligent Aquarium v7.1
// Fix: field names khớp Firebase JSON
//      + fb_ph / fb_tds / fb_temp > 12 → sensor error UI
// ================================================================

import { listenRef, setRef, onConnectionChange, requireAuth, doLogout } from './firebase-init.js';
import { fetchHistory, onNewPoint, startPolling } from './history-service.js';
import { initCharts, loadHistory, addPoint, exportCSV } from './chart-panel.js';

// ================================================================
// GAUGE ARC HELPER
// ================================================================
const GAUGE_CIRC_LG = 188.5;
const GAUGE_CIRC_SM = 106.8;

function updateArc(arcId, value, min, max, circ = GAUGE_CIRC_LG) {
    const arc = document.getElementById(arcId);
    if (!arc) return;
    const pct = Math.min(1, Math.max(0, (value - min) / (max - min)));
    arc.style.strokeDashoffset = circ * (1 - pct);
}

// ================================================================
// TIMESTAMP HELPERS
// ================================================================
const VN_OFFSET = 7 * 3600 * 1000;

function toVnTime(epochMs) {
    const d = new Date(epochMs);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
}

function toVnDate(epochMs) {
    const now = new Date();
    const then = new Date(epochMs);
    const sameDay = now.toDateString() === then.toDateString();
    if (sameDay) return 'hôm nay ' + toVnTime(epochMs);
    const dd = String(then.getDate()).padStart(2, '0');
    const mo = String(then.getMonth() + 1).padStart(2, '0');
    return dd + '/' + mo + ' ' + toVnTime(epochMs);
}

function toVnDateOnly(epochMs) {
    var now = new Date();
    var then = new Date(epochMs);
    if (now.toDateString() === then.toDateString()) return 'hôm nay';
    var yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (yesterday.toDateString() === then.toDateString()) return 'hôm qua';
    var dd = String(then.getDate()).padStart(2, '0');
    var mo = String(then.getMonth() + 1).padStart(2, '0');
    return dd + '/' + mo;
}

function fmtUptime(sec) {
    if (!sec) return '↑ --';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h > 0 ? '↑ ' + h + 'h ' + m + 'm' : '↑ ' + m + 'm';
}

// ================================================================
// SENSOR ERROR STATE — fb_* > 12
// ================================================================
const SENSOR_ERROR_THRESHOLD = 12;

/**
 * Kiểm tra và cập nhật UI cảnh báo lỗi sensor dựa trên fb_* counter.
 * fb_temp / fb_ph / fb_tds: số lần liên tiếp phải dùng fallback.
 * Nếu > 12 → sensor bị hư → hiện lỗi đỏ.
 */
function updateSensorErrorState(sensor, fbCount) {
    const isBroken = typeof fbCount === 'number' && fbCount > SENSOR_ERROR_THRESHOLD;

    const cardMap = { temp: 'card-temp', ph: 'card-ph', tds: 'card-tds' };
    const valMap = { temp: 'val-temp', ph: 'val-ph', tds: 'val-tds' };
    const dotMap = { temp: 'dot-temp', ph: 'dot-ph', tds: 'dot-tds' };
    const arcMap = { temp: 'arc-temp', ph: 'arc-ph', tds: 'arc-tds' };
    const badgeMap = { temp: 'badge-temp-src', ph: 'badge-ph-src', tds: 'badge-tds-src' };

    const card = document.getElementById(cardMap[sensor]);
    const valEl = document.getElementById(valMap[sensor]);
    const dotEl = document.getElementById(dotMap[sensor]);
    const arcEl = document.getElementById(arcMap[sensor]);
    const badge = document.getElementById(badgeMap[sensor]);

    if (isBroken) {
        // Đặt class lỗi cho card
        if (card) card.classList.add('sensor-broken');

        // Giá trị hiển thị lỗi
        if (valEl) valEl.textContent = 'ERR';

        // Arc chuyển đỏ, offset = full (không hiện)
        if (arcEl) {
            arcEl.style.stroke = 'var(--accent-err)';
            arcEl.style.strokeDashoffset = (sensor === 'temp' || sensor === 'ph' || sensor === 'tds') ?
                GAUGE_CIRC_LG.toString() :
                GAUGE_CIRC_LG.toString();
        }

        // Status dot
        if (dotEl) dotEl.className = 'status-dot error';

        // Badge
        if (badge) {
            badge.textContent = 'HƯ';
            badge.className = 'source-badge error-badge';
        }

        // Hiện overlay cảnh báo trong card nếu chưa có
        if (card && !card.querySelector('.sensor-broken-overlay')) {
            const overlay = document.createElement('div');
            overlay.className = 'sensor-broken-overlay';
            overlay.innerHTML =
                '<span class="broken-icon">⚠</span>' +
                '<span class="broken-title">Sensor lỗi</span>' +
                '<span class="broken-sub">Fallback liên tiếp: <strong>' + fbCount + '</strong> lần</span>' +
                '<span class="broken-hint">Kiểm tra kết nối sensor</span>';
            card.appendChild(overlay);
        } else if (card) {
            // Cập nhật số lần nếu overlay đã có
            const sub = card.querySelector('.broken-sub');
            if (sub) sub.innerHTML = 'Fallback liên tiếp: <strong>' + fbCount + '</strong> lần';
        }
    } else {
        // Xoá trạng thái lỗi
        if (card) card.classList.remove('sensor-broken');
        const _ov = card && card.querySelector('.sensor-broken-overlay');
        if (_ov) _ov.remove();

        // Reset arc màu về mặc định
        if (arcEl) {
            const colorMap = { temp: '#f59e0b', ph: '#2dd4bf', tds: '#a78bfa' };
            arcEl.style.stroke = colorMap[sensor] || '';
            arcEl.style.strokeDashoffset = '';
        }

        // Reset status dot về ok
        if (dotEl) dotEl.className = 'status-dot ok';

        // Reset badge về MEAS (sẽ được cập nhật đúng ở lần telemetry tiếp theo)
        if (badge) {
            badge.textContent = 'MEAS';
            badge.className = 'source-badge measured';
        }
    }

    return isBroken;
}

// ================================================================
// STATUS / ONLINE
// ================================================================
function updateStatus(snap) {
    if (!snap.exists()) return;
    const d = snap.val();

    document.getElementById('dot-online').className = 'status-dot online';
    document.getElementById('txt-online').textContent = 'Online';
    document.getElementById('txt-uptime').textContent = fmtUptime(d.uptime_s);

    const banner = document.getElementById('banner-safe-mode');
    banner.classList.toggle('visible', !!d.safe_mode);
}

// ================================================================
// TELEMETRY
// ================================================================
let gaugeRanges = {
    temp: { min: 15, max: 40 },
    ph: { min: 4, max: 10 },
    tds: { min: 0, max: 1000 },
};

const STATUS_DOT_CLASS = {
    OK: 'ok',
    MAD_OUTLIER: 'warn',
    OUT_OF_RANGE: 'warn', // warn (không hẳn lỗi phần cứng)
    SENSOR_ERROR: 'error',
    FALLBACK_DEFAULT: 'warn',
    FALLBACK_LAST: 'warn',
};


// ================================================================
// FIRMWARE STALENESS DETECTOR
// Nếu telemetry không thay đổi trong 30s -> báo firmware offline
// ================================================================
var _lastTelemetryHash = null;
var _lastTelemetryTime = Date.now();
var _firmwareOnline = true;
var STALE_TIMEOUT_MS = 30000; // 30 giây

function hashTelemetry(d) {
    // Dùng timestamp + các giá trị cảm biến làm fingerprint
    return (d.timestamp || 0) + '|' + (d.temperature || 0) + '|' + (d.ph || 0) + '|' + (d.tds || 0);
}

function setFirmwareOnline(online) {
    if (online === _firmwareOnline) return; // không thay đổi -> bỏ qua
    _firmwareOnline = online;

    var dot = document.getElementById('dot-online');
    var txt = document.getElementById('txt-online');

    if (online) {
        if (dot) dot.className = 'status-dot online';
        if (txt) txt.textContent = 'Online';
        // Ẩn banner stale nếu có
        var b = document.getElementById('banner-stale');
        if (b) b.classList.remove('visible');
    } else {
        if (dot) dot.className = 'status-dot offline';
        if (txt) txt.textContent = 'Firmware offline';
        // Hiện banner stale
        var b2 = document.getElementById('banner-stale');
        if (b2) b2.classList.add('visible');
    }
}

function startStalenessWatcher() {
    setInterval(function() {
        var elapsed = Date.now() - _lastTelemetryTime;
        if (elapsed >= STALE_TIMEOUT_MS) {
            setFirmwareOnline(false);
        }
    }, 5000); // kiểm tra mỗi 5s
}

function updateTelemetry(snap) {
    if (!snap.exists()) return;
    const d = snap.val();

    // Staleness check: cập nhật thời gian nhận data mới nhất
    var hash = hashTelemetry(d);
    if (hash !== _lastTelemetryHash) {
        _lastTelemetryHash = hash;
        _lastTelemetryTime = Date.now();
        setFirmwareOnline(true);
    }

    // ── fb_* counters → kiểm tra lỗi sensor TRƯỚC ──────────────
    const tempBroken = updateSensorErrorState('temp', d.fb_temp);
    const phBroken = updateSensorErrorState('ph', d.fb_ph);
    const tdsBroken = updateSensorErrorState('tds', d.fb_tds);

    // ── Nhiệt độ ─────────────────────────────────────────────────
    // Firebase field: "temperature", source: "temp_source", status: "temp_status"
    if (d.temperature !== undefined && !tempBroken) {
        document.getElementById('val-temp').textContent =
            parseFloat(d.temperature).toFixed(1);
        updateArc('arc-temp', d.temperature, gaugeRanges.temp.min, gaugeRanges.temp.max);
        setStatusDot('dot-temp', d.temp_status);
        setSourceBadge('badge-temp-src', d.temp_source);
        if (d.shock_temp) shockFlash('card-temp');
    }

    // ── pH ───────────────────────────────────────────────────────
    // Firebase field: "ph", source: "ph_source", status: "ph_status"
    if (d.ph !== undefined && !phBroken) {
        document.getElementById('val-ph').textContent =
            parseFloat(d.ph).toFixed(2);
        updateArc('arc-ph', d.ph, gaugeRanges.ph.min, gaugeRanges.ph.max);
        setStatusDot('dot-ph', d.ph_status);
        setSourceBadge('badge-ph-src', d.ph_source);
        if (d.shock_ph) shockFlash('card-ph');
    }

    // ── TDS ──────────────────────────────────────────────────────
    // Firebase field: "tds", source: "tds_source", status: "tds_status"
    if (d.tds !== undefined && !tdsBroken) {
        document.getElementById('val-tds').textContent =
            Math.round(d.tds).toString();
        updateArc('arc-tds', d.tds, gaugeRanges.tds.min, gaugeRanges.tds.max);
        setStatusDot('dot-tds', d.tds_status);
        setSourceBadge('badge-tds-src', d.tds_source);
    }
}

function setStatusDot(dotId, status) {
    const el = document.getElementById(dotId);
    if (!el || !status) return;
    // Nếu card đang ở trạng thái broken, không override
    const card = el.closest('.card');
    if (card && card.classList.contains('sensor-broken')) return;
    const cls = STATUS_DOT_CLASS[status] || 'warn';
    el.className = 'status-dot ' + cls;
}

function setSourceBadge(badgeId, source) {
    const el = document.getElementById(badgeId);
    if (!el || !source) return;
    if (el.classList.contains('error-badge')) return; // đang hiện "HƯ"
    const isMeas = source === 'MEASURED';
    el.textContent = isMeas ? 'MEAS' : 'FB';
    el.className = 'source-badge ' + (isMeas ? 'measured' : 'fallback');
}

function shockFlash(cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;
    card.classList.add('shock-flash');
    setTimeout(function() { card.classList.remove('shock-flash'); }, 3000);
}

// ================================================================
// USER CONFIG — gauge ranges
// ================================================================
function updateUserConfig(snap) {
    if (!snap.exists()) return;
    const d = snap.val();
    const TEMP_PAD = 2,
        PH_PAD = 0.5,
        TDS_PAD = 50;

    if (d.temp_min !== undefined && d.temp_max !== undefined) {
        gaugeRanges.temp.min = parseFloat(d.temp_min) - TEMP_PAD;
        gaugeRanges.temp.max = parseFloat(d.temp_max) + TEMP_PAD;
        document.getElementById('min-temp').textContent = gaugeRanges.temp.min.toFixed(1) + '°C';
        document.getElementById('max-temp').textContent = gaugeRanges.temp.max.toFixed(1) + '°C';
    }
    if (d.ph_min !== undefined && d.ph_max !== undefined) {
        gaugeRanges.ph.min = parseFloat(d.ph_min) - PH_PAD;
        gaugeRanges.ph.max = parseFloat(d.ph_max) + PH_PAD;
        document.getElementById('min-ph').textContent = gaugeRanges.ph.min.toFixed(1);
        document.getElementById('max-ph').textContent = gaugeRanges.ph.max.toFixed(1);
    }
    if (d.tds_target !== undefined && d.tds_tolerance !== undefined) {
        const target = parseFloat(d.tds_target);
        const tol = parseFloat(d.tds_tolerance);
        gaugeRanges.tds.min = Math.max(0, target - tol - TDS_PAD);
        gaugeRanges.tds.max = target + tol + TDS_PAD;
        document.getElementById('min-tds').textContent = Math.round(gaugeRanges.tds.min);
        document.getElementById('max-tds').textContent = Math.round(gaugeRanges.tds.max) + ' ppm';
    }
}

// ================================================================
// RELAY STATE
// ================================================================
const RELAY_MAP = {
    heater: { item: 'relay-heater', toggle: 'toggle-heater' },
    cooler: { item: 'relay-cooler', toggle: 'toggle-cooler' },
    ph_up: { item: 'relay-ph-up', toggle: 'toggle-ph-up' },
    ph_down: { item: 'relay-ph-down', toggle: 'toggle-ph-down' },
    pump_in: { item: 'relay-pump-in', toggle: 'toggle-pump-in' },
    pump_out: { item: 'relay-pump-out', toggle: 'toggle-pump-out' },
};

function updateRelayState(snap) {
    if (!snap.exists()) return;
    const d = snap.val();
    for (const [key, ids] of Object.entries(RELAY_MAP)) {
        const on = !!d[key];
        const item = document.getElementById(ids.item);
        const toggle = document.getElementById(ids.toggle);
        if (item) item.classList.toggle('on', on);
        if (toggle) toggle.classList.toggle('on', on);
    }
}

// ================================================================
// WATER CHANGE
// ================================================================
let wcConfig = { pump_out_sec: 30, pump_in_sec: 60 };
let wcStateStartMs = 0;
let wcProgressTimer = null;

function updateWaterChange(snap) {
    if (!snap.exists()) return;
    const d = snap.val();

    const badge = document.getElementById('wc-state-badge');
    const state = (d.state || 'IDLE').toUpperCase();
    badge.className = 'wc-state-badge';
    if (state === 'PUMPING_OUT') {
        badge.classList.add('pumping-out');
        badge.textContent = 'BƠM RA';
    } else if (state === 'PUMPING_IN') {
        badge.classList.add('pumping-in');
        badge.textContent = 'BƠM VÀO';
    } else {
        badge.classList.add('idle');
        badge.textContent = 'IDLE';
    }

    const btn = document.getElementById('btn-water-change');
    btn.disabled = (state !== 'IDLE');

    const wrap = document.getElementById('wc-progress-wrap');
    if (state !== 'IDLE') {
        wrap.classList.add('visible');
        const duration = state === 'PUMPING_OUT' ?
            (wcConfig.pump_out_sec || 30) * 1000 :
            (wcConfig.pump_in_sec || 60) * 1000;
        startProgressTimer(duration);
    } else {
        wrap.classList.remove('visible');
        stopProgressTimer();
    }

    // Ưu tiên last_run_ts (Unix timestamp thực từ NTP)
    // Fallback về last_run (số ngày) nếu chưa có
    var rawTs = (d.last_run_ts && d.last_run_ts > 0) ? d.last_run_ts : null;
    var rawDay = (d.last_run && d.last_run > 0) ? d.last_run : null;

    if (rawTs) {
        var ts = rawTs * 1000;
        document.getElementById('wc-last-run').textContent = 'Lần cuối: ' + toVnDate(ts);
    } else if (rawDay) {
        var ts2 = rawDay > 1000000000 ? rawDay * 1000 : rawDay * 86400 * 1000;
        var isUnixSec = rawDay > 1000000000;
        document.getElementById('wc-last-run').textContent = 'Lần cuối: ' + (isUnixSec ? toVnDate(ts2) : toVnDateOnly(ts2));
    }
}

function startProgressTimer(durationMs) {
    stopProgressTimer();
    wcStateStartMs = Date.now();
    const fill = document.getElementById('wc-progress-fill');
    const pct = document.getElementById('wc-progress-pct');
    wcProgressTimer = setInterval(function() {
        const elapsed = Date.now() - wcStateStartMs;
        const p = Math.min(100, Math.round(elapsed / durationMs * 100));
        fill.style.width = p + '%';
        pct.textContent = p + '%';
        if (p >= 100) stopProgressTimer();
    }, 500);
}

function stopProgressTimer() {
    if (wcProgressTimer) {
        clearInterval(wcProgressTimer);
        wcProgressTimer = null;
    }
    const fill = document.getElementById('wc-progress-fill');
    const pct = document.getElementById('wc-progress-pct');
    if (fill) fill.style.width = '0%';
    if (pct) pct.textContent = '0%';
}

function triggerWaterChange() {
    var btn = document.getElementById('btn-water-change');
    btn.disabled = true;
    setRef('water_change/manual_trigger', true).catch(function(e) {
        console.error('Trigger failed:', e);
        btn.disabled = false;
    });
}
window.triggerWaterChange = triggerWaterChange;

// ================================================================
// WATER SCHEDULE
// ================================================================
function updateWaterSchedule(snap) {
    if (!snap.exists()) return;
    const d = snap.val();
    wcConfig.pump_out_sec = d.pump_out_sec || 30;
    wcConfig.pump_in_sec = d.pump_in_sec || 60;

    const schInfo = document.getElementById('wc-schedule-info');
    if (schInfo) {
        if (d.enabled) {
            const hh = String(d.hour || 6).padStart(2, '0');
            const mm = String(d.minute || 0).padStart(2, '0');
            schInfo.textContent = 'Lịch: Tự động ' + hh + ':' + mm + ' mỗi ngày';
        } else {
            schInfo.textContent = 'Lịch: Tắt';
        }
    }
}

// ================================================================
// ANALYTICS
// ================================================================
function updateAnalytics(snap) {
    if (!snap.exists()) return;
    const d = snap.val();

    if (d.wsi !== undefined) {
        const wsi = parseFloat(d.wsi);
        document.getElementById('val-wsi').textContent = Math.round(wsi);
        updateArc('arc-wsi', wsi, 0, 100, GAUGE_CIRC_SM);
        const wsiArc = document.getElementById('arc-wsi');
        if (wsiArc) wsiArc.style.stroke = wsi > 70 ? '#34d399' : wsi > 40 ? '#fbbf24' : '#f87171';
        document.getElementById('txt-wsi-status').textContent =
            wsi > 70 ? 'Tốt' : wsi > 40 ? 'Ổn' : 'Kém';
        document.getElementById('txt-wsi-status').style.color =
            wsi > 70 ? 'var(--accent-ok)' : wsi > 40 ? 'var(--accent-warn)' : 'var(--accent-err)';
    }

    if (d.fsi !== undefined) {
        const fsi = parseFloat(d.fsi);
        document.getElementById('val-fsi').textContent = fsi.toFixed(1);
        updateArc('arc-fsi', fsi, 0, 100, GAUGE_CIRC_SM);
        const fsiArc = document.getElementById('arc-fsi');
        if (fsiArc) fsiArc.style.stroke = fsi < 30 ? '#34d399' : fsi < 60 ? '#fbbf24' : '#f87171';
        document.getElementById('txt-fsi-status').textContent =
            fsi < 30 ? 'Ổn định' : fsi < 60 ? 'Biến động' : 'Bất ổn';
        document.getElementById('txt-fsi-status').style.color =
            fsi < 30 ? 'var(--accent-ok)' : fsi < 60 ? 'var(--accent-warn)' : 'var(--accent-err)';
    }

    setDrift('drift-temp', d.drift_temp);
    setDrift('drift-ph', d.drift_ph);
    setDrift('drift-tds', d.drift_tds);
}

function setDrift(elId, val) {
    const el = document.getElementById(elId);
    if (!el) return;
    const v = (val || 'NONE').toUpperCase();
    el.textContent = v;
    el.className = v === 'UP' ? 'drift-up' : v === 'DOWN' ? 'drift-down' : 'drift-none';
}

// ================================================================
// SAFETY EVENTS
// ================================================================
const CRITICAL_EVENTS = ['THERMAL_CUTOFF', 'EMERGENCY_COOL'];
let logEntries = [];

function updateSafetyEvents(snap) {
    if (!snap.exists()) return;
    const raw = snap.val();
    const entries = Object.values(raw)
        .filter(function(e) { return e && e.event; })
        .sort(function(a, b) { return (b.timestamp || 0) - (a.timestamp || 0); })
        .slice(0, 10);

    logEntries = entries;
    renderSafetyLog();

    const today = new Date(Date.now() + VN_OFFSET).toDateString();
    var todayCount = entries.filter(function(e) {
        var d = new Date((e.timestamp || 0) * 1000 + VN_OFFSET);
        return d.toDateString() === today;
    }).length;

    const badge = document.getElementById('log-count-badge');
    if (todayCount > 0) {
        badge.textContent = todayCount;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

function renderSafetyLog() {
    const tbody = document.getElementById('safety-log-body');
    if (!tbody) return;
    if (logEntries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-dim);padding:16px 0;font-size:0.75rem">Chưa có sự kiện</td></tr>';
        return;
    }
    tbody.innerHTML = logEntries.map(function(e) {
        const isCrit = CRITICAL_EVENTS.includes(e.event);
        const dotCls = isCrit ? 'critical' : 'warn';
        const tsStr = e.timestamp ? toVnTime(e.timestamp * 1000) : '--:--';
        const valStr = e.value !== undefined ? parseFloat(e.value).toFixed(1) : '';
        return '<tr>' +
            '<td><span class="log-dot ' + dotCls + '"></span></td>' +
            '<td>' + tsStr + '</td>' +
            '<td class="event-name">' + fmtEventName(e.event) + '</td>' +
            '<td class="event-val">' + valStr + '</td>' +
            '</tr>';
    }).join('');
}

function fmtEventName(raw) {
    const MAP = {
        THERMAL_CUTOFF: 'Cắt nhiệt',
        EMERGENCY_COOL: 'Làm mát khẩn',
        HEATER_RUNTIME_LIMIT: 'Heater quá giờ',
        HEATER_COOLDOWN: 'Heater nghỉ',
        SENSOR_UNRELIABLE: 'Sensor lỗi',
        SENSOR_STALE: 'Sensor cũ',
        MUTUAL_EXCLUSION: 'Xung đột relay',
        PH_PUMP_INTERVAL: 'pH interval',
        SHOCK_GUARD: 'Sốc cảm biến',
    };
    return MAP[raw] || raw;
}

// ================================================================
// INJECT CSS cho sensor-broken UI
// ================================================================
function injectSensorBrokenStyles() {
    if (document.getElementById('sensor-broken-style')) return;
    const style = document.createElement('style');
    style.id = 'sensor-broken-style';
    style.textContent = [
        '',
        '        /* Card bị lỗi sensor */',
        '        .card.sensor-broken {',
        '            border: 1px solid rgba(248, 113, 113, 0.45) !important;',
        '            background: rgba(248, 113, 113, 0.04) !important;',
        '            position: relative;',
        '            overflow: hidden;',
        '        }',
        '',
        '        .card.sensor-broken::before {',
        '            content: \\\'\\\';',
        '            position: absolute;',
        '            inset: 0;',
        '            background: repeating-linear-gradient(',
        '                -45deg,',
        '                transparent,',
        '                transparent 6px,',
        '                rgba(248, 113, 113, 0.04) 6px,',
        '                rgba(248, 113, 113, 0.04) 12px',
        '            );',
        '            pointer-events: none;',
        '            z-index: 0;',
        '            animation: broken-stripe 8s linear infinite;',
        '        }',
        '',
        '        @keyframes broken-stripe {',
        '            from { background-position: 0 0; }',
        '            to   { background-position: 24px 24px; }',
        '        }',
        '',
        '        /* Overlay thông tin lỗi */',
        '        .sensor-broken-overlay {',
        '            position: absolute;',
        '            inset: 0;',
        '            display: flex;',
        '            flex-direction: column;',
        '            align-items: center;',
        '            justify-content: center;',
        '            gap: 2px;',
        // '            background: rgba(10, 12, 16, 0.75);',
        '            backdrop-filter: blur(5px);',
        '            z-index: 10;',
        '            border-radius: inherit;',
        '            animation: broken-fade-in 0.3s ease;',
        '        }',
        '',
        '        @keyframes broken-fade-in {',
        '            from { opacity: 0; transform: scale(0.97); }',
        '            to   { opacity: 1; transform: scale(1); }',
        '        }',
        '',
        '        .broken-icon {',
        '            font-size: 1.4rem;',
        '            animation: broken-pulse 1.4s ease-in-out infinite;',
        '        }',
        '',
        '        @keyframes broken-pulse {',
        '            0%, 100% { opacity: 1;   transform: scale(1); }',
        '            50%       { opacity: 0.6; transform: scale(0.92); }',
        '        }',
        '',
        '        .broken-title {',
        '            font-size: 0.8rem;',
        '            font-weight: 700;',
        '            color: var(--accent-err, #f87171);',
        '            letter-spacing: 0.04em;',
        '        }',
        '',
        '        .broken-sub {',
        '            font-size: 0.68rem;',
        '            color: var(--text-sub, #94a3b8);',
        '            margin-top: 1px;',
        '        }',
        '',
        '        .broken-sub strong {',
        '            color: var(--accent-err, #f87171);',
        '        }',
        '',
        '        .broken-hint {',
        '            font-size: 0.64rem;',
        '            color: var(--text-dim, #64748b);',
        '            margin-top: 3px;',
        '        }',
        '',
        '        /* Badge lỗi */',
        '        .source-badge.error-badge {',
        '            background: rgba(248, 113, 113, 0.18);',
        '            color: var(--accent-err, #f87171);',
        '            border: 1px solid rgba(248, 113, 113, 0.35);',
        '            font-weight: 700;',
        '            animation: broken-pulse 1.4s ease-in-out infinite;',
        '        }',
        '    '
    ].join('\n');
    document.head.appendChild(style);
}

// ================================================================
// INIT
// ================================================================
(async function init() {
    await requireAuth();
    injectSensorBrokenStyles();

    listenRef('status', updateStatus);
    listenRef('settings/config', updateUserConfig);
    listenRef('telemetry', updateTelemetry);
    listenRef('relay_state', updateRelayState);
    listenRef('water_change', updateWaterChange);
    listenRef('settings/water_schedule', updateWaterSchedule);
    listenRef('analytics', updateAnalytics);

    // Firmware staleness watcher
    startStalenessWatcher();

    // Offline banner — dùng onConnectionChange từ firebase-init
    onConnectionChange(function(connected) {
        document.getElementById('banner-offline')
            .classList.toggle('visible', !connected);
    });

    // ── Biểu đồ lịch sử ─────────────────────────────────────────
    initCharts();

    onNewPoint(function({ sensor, value, ts }) {
        addPoint(sensor, value, ts);
    });

    fetchHistory().then(function(history) {
        loadHistory(history);
        console.log('[dashboard] history loaded',
            history.temp.length, 'temp pts,',
            history.ph.length, 'ph pts,',
            history.tds.length, 'tds pts'
        );
        // Bắt đầu lắng nghe realtime RTDB sau khi đã nạp lịch sử
        startPolling();
    }).catch(function(e) {
        console.warn('[dashboard] fetchHistory failed:', e);
        startPolling(); // vẫn lắng nghe realtime dù fetch lỗi
    });

})();