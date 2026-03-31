// ================================================================
// dashboard.js — Intelligent Aquarium v7.2
// Fix: pH đọc từ ph_session/last_median_ph thay vì telemetry
// ================================================================

import { listenRef, setRef, updateRef, readOnce, onConnectionChange, requireAuth, doLogout } from './firebase-init.js';
import { db, DEVICE_ID } from './firebase-init.js';
import {
    ref as fbRef,
    onValue,
    onChildAdded,
    orderByKey,
    query as fbQuery,
    get as fbGet,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
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
        if (card) card.classList.add('sensor-broken');
        if (valEl) valEl.textContent = 'ERR';
        if (arcEl) {
            arcEl.style.stroke = 'var(--accent-err)';
            arcEl.style.strokeDashoffset = GAUGE_CIRC_LG.toString();
        }
        if (dotEl) dotEl.className = 'status-dot error';
        if (badge) {
            badge.textContent = 'LỖI';
            badge.className = 'source-badge error-badge';
        }
        if (card && !card.querySelector('.sensor-broken-overlay')) {
            const overlay = document.createElement('div');
            overlay.className = 'sensor-broken-overlay';
            overlay.innerHTML =
                '<span class="broken-icon">⚠</span>' +
                '<span class="broken-title">Lỗi sensor</span>' +
                '<span class="broken-sub">Kiểm tra lại kết nối sensor</span>' +
                '<span class="broken-hint">Hệ thống đang dùng giá trị dự phòng</span>';
            card.appendChild(overlay);
        }
    } else {
        if (card) card.classList.remove('sensor-broken');
        const _ov = card && card.querySelector('.sensor-broken-overlay');
        if (_ov) _ov.remove();
        if (arcEl) {
            const colorMap = { temp: '#f59e0b', ph: '#2dd4bf', tds: '#a78bfa' };
            arcEl.style.stroke = colorMap[sensor] || '';
            arcEl.style.strokeDashoffset = '';
        }
        if (dotEl) dotEl.className = 'status-dot ok';
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
// TELEMETRY — chỉ Temp + TDS, pH đã chuyển sang ph_session
// ================================================================
let gaugeRanges = {
    temp: { min: 15, max: 40 },
    ph: { min: 4, max: 10 },
    tds: { min: 0, max: 1000 },
};

const STATUS_DOT_CLASS = {
    OK: 'ok',
    MAD_OUTLIER: 'warn',
    OUT_OF_RANGE: 'warn',
    SENSOR_ERROR: 'error',
    FALLBACK_DEFAULT: 'warn',
    FALLBACK_LAST: 'warn',
};

// ── Firmware staleness ───────────────────────────────────────────
var _lastTelemetryHash = null;
var _lastTelemetryTime = Date.now();
var _firmwareOnline = true;
var STALE_TIMEOUT_MS = 30000;

function hashTelemetry(d) {
    return (d.timestamp || 0) + '|' + (d.temperature || 0) + '|' + (d.tds || 0);
}

function setFirmwareOnline(online) {
    if (online === _firmwareOnline) return;
    _firmwareOnline = online;
    var dot = document.getElementById('dot-online');
    var txt = document.getElementById('txt-online');
    if (online) {
        if (dot) dot.className = 'status-dot online';
        if (txt) txt.textContent = 'Online';
        var b = document.getElementById('banner-stale');
        if (b) b.classList.remove('visible');
    } else {
        if (dot) dot.className = 'status-dot offline';
        if (txt) txt.textContent = 'Firmware offline';
        var b2 = document.getElementById('banner-stale');
        if (b2) b2.classList.add('visible');
    }
}

function startStalenessWatcher() {
    setInterval(function() {
        if (Date.now() - _lastTelemetryTime >= STALE_TIMEOUT_MS) {
            setFirmwareOnline(false);
        }
    }, 5000);
}

function updateTelemetry(snap) {
    if (!snap.exists()) return;
    const d = snap.val();

    // Staleness check
    var hash = hashTelemetry(d);
    if (hash !== _lastTelemetryHash) {
        _lastTelemetryHash = hash;
        _lastTelemetryTime = Date.now();
        setFirmwareOnline(true);
    }

    // ── Sensor error state — temp + tds
    const tempBroken = updateSensorErrorState('temp', d.fb_temp);
    const tdsBroken = updateSensorErrorState('tds', d.fb_tds);

    // ── Nhiệt độ ─────────────────────────────────────────────────
    if (d.temperature !== undefined && !tempBroken) {
        document.getElementById('val-temp').textContent =
            parseFloat(d.temperature).toFixed(1);
        updateArc('arc-temp', d.temperature, gaugeRanges.temp.min, gaugeRanges.temp.max);
        setStatusDot('dot-temp', d.temp_status);
        setSourceBadge('badge-temp-src', d.temp_source);
        if (d.shock_temp) shockFlash('card-temp');
    }

    // ── TDS ──────────────────────────────────────────────────────
    if (d.tds !== undefined && !tdsBroken) {
        document.getElementById('val-tds').textContent =
            Math.round(d.tds).toString();
        updateArc('arc-tds', d.tds, gaugeRanges.tds.min, gaugeRanges.tds.max);
        setStatusDot('dot-tds', d.tds_status);
        setSourceBadge('badge-tds-src', d.tds_source);
    }

    // pH không đọc từ telemetry nữa — xem updatePhSession()
}

// ================================================================
// PH SESSION — nguồn dữ liệu pH duy nhất
// ================================================================
function updatePhSession(snap) {
    if (!snap.exists()) return;
    const d = snap.val();

    const ph = d.last_median_ph;
    if (ph === undefined || ph === null) return;

    // Không cập nhật nếu card đang ở trạng thái sensor broken
    const card = document.getElementById('card-ph');
    if (card && card.classList.contains('sensor-broken')) return;

    document.getElementById('val-ph').textContent = parseFloat(ph).toFixed(2);
    updateArc('arc-ph', ph, gaugeRanges.ph.min, gaugeRanges.ph.max);

    setStatusDot('dot-ph', 'OK');

    // Badge — hiện trạng thái session
    const badge = document.getElementById('badge-ph-src');
    if (badge && !badge.classList.contains('shock-badge') && !badge.classList.contains('error-badge')) {
        const state = (d.state || 'IDLE');
        const isMeasuring = (state === 'COLLECTING' || state === 'SAFE_MODE_WAIT');
        badge.textContent = isMeasuring ? 'ĐO...' : 'MEAS';
        badge.className = 'source-badge ' + (isMeasuring ? 'fallback' : 'measured');
    }
}

// ================================================================
// PH SENSOR ERROR — lắng nghe ph_session/sensor_error (true/false)
// Dùng cùng updateSensorErrorState như Temp/TDS
// ================================================================
const PH_SENSOR_ERROR_PATH = () => `devices/${DEVICE_ID}/ph_session/sensor_error`;

function _initPhSensorErrorListener() {
    onValue(fbRef(db, PH_SENSOR_ERROR_PATH()), function(snap) {
        // Firmware ghi string "true"/"false" để Firebase không tự xóa node
        const isBroken = snap.exists() && snap.val() === "true";
        // Tái dùng updateSensorErrorState với fbCount giả:
        // isBroken=true  → fbCount = SENSOR_ERROR_THRESHOLD + 1 (> threshold)
        // isBroken=false → fbCount = 0
        const fakeCount = isBroken ? SENSOR_ERROR_THRESHOLD + 1 : 0;
        updateSensorErrorState('ph', fakeCount);
    });
}

// ================================================================
// BADGE / DOT HELPERS
// ================================================================
function setStatusDot(dotId, status) {
    const el = document.getElementById(dotId);
    if (!el || !status) return;
    const card = el.closest('.card');
    if (card && card.classList.contains('sensor-broken')) return;
    const cls = STATUS_DOT_CLASS[status] || 'warn';
    el.className = 'status-dot ' + cls;
}

function setSourceBadge(badgeId, source) {
    const el = document.getElementById(badgeId);
    if (!el || !source) return;
    if (el.classList.contains('error-badge')) return;
    if (el.classList.contains('shock-badge')) return;
    const isMeas = source === 'MEASURED';
    el.textContent = isMeas ? 'MEAS' : 'FB';
    el.className = 'source-badge ' + (isMeas ? 'measured' : 'fallback');
}

// ================================================================
// SHOCK FLASH
// ================================================================
var _shockBadgeTimers = {};
var SHOCK_CARD_BADGE_TTL_MS = 30000;

function shockFlash(cardId) {
    var sensorKey = cardId.replace('card-', '');
    var badgeId = 'badge-' + sensorKey + '-src';
    var card = document.getElementById(cardId);
    var badge = document.getElementById(badgeId);
    if (!card || !badge) return;

    if (!_shockBadgeTimers[sensorKey]) _shockBadgeTimers[sensorKey] = {};
    if (!badge.classList.contains('shock-badge')) {
        _shockBadgeTimers[sensorKey].lastText = badge.textContent;
        _shockBadgeTimers[sensorKey].lastClass = badge.className;
    }

    card.classList.remove('shock-active-out');
    card.classList.add('shock-active');
    badge.textContent = '⚡ SHOCK';
    badge.className = 'source-badge shock-badge';

    if (_shockBadgeTimers[sensorKey].timer)
        clearTimeout(_shockBadgeTimers[sensorKey].timer);

    _shockBadgeTimers[sensorKey].timer = setTimeout(function() {
        var saved = _shockBadgeTimers[sensorKey];
        if (badge && saved.lastText) {
            badge.textContent = saved.lastText;
            badge.className = saved.lastClass || 'source-badge measured';
        }
        card.classList.remove('shock-active');
        card.classList.add('shock-active-out');
        setTimeout(function() { card.classList.remove('shock-active-out'); }, 1500);
        delete _shockBadgeTimers[sensorKey];
    }, SHOCK_CARD_BADGE_TTL_MS);
}

// ================================================================
// SHOCK DIALOG + SHOCK LOG
// ================================================================
const SHOCK_PH_PATH = () => `devices/${DEVICE_ID}/history/shock_event_ph`;
const SHOCK_TEMP_PATH = () => `devices/${DEVICE_ID}/history/shock_event_temp`;
const SAFETY_FB_PATH = () => `devices/${DEVICE_ID}/history/last_safety_event`;

var _shockEntries = [];
var _shockDialogReady = false;
var _shockDialogCurrentKey = null;
var _shockDialogCurrentType = null;

function _initShockDialog() {
    if (_shockDialogReady) return;
    var btn = document.getElementById('shock-dialog-confirm');
    if (btn) btn.addEventListener('click', _onShockDialogConfirm);
    var overlay = document.getElementById('shock-dialog-overlay');
    if (overlay) overlay.addEventListener('click', function(e) {
        if (e.target === overlay) _onShockDialogConfirm();
    });
    _shockDialogReady = true;
}

function _showShockDialog(key, type, before, after, tsMs) {
    _initShockDialog();
    _shockDialogCurrentKey = key;
    _shockDialogCurrentType = type;

    var overlay = document.getElementById('shock-dialog-overlay');
    var titleEl = document.getElementById('shock-dialog-title');
    var beforeEl = document.getElementById('shock-dialog-before');
    var afterEl = document.getElementById('shock-dialog-after');
    var labelEl = document.getElementById('shock-dialog-label');
    var timeEl = document.getElementById('shock-dialog-time');
    if (!overlay) return;

    if (type === 'ph') {
        if (titleEl) titleEl.textContent = '⚡ Shock pH phát hiện';
        if (labelEl) labelEl.textContent = 'pH';
        if (beforeEl) beforeEl.textContent = parseFloat(before).toFixed(2);
        if (afterEl) afterEl.textContent = parseFloat(after).toFixed(2);
    } else {
        if (titleEl) titleEl.textContent = '🌡 Shock Nhiệt độ phát hiện';
        if (labelEl) labelEl.textContent = 'Nhiệt độ';
        if (beforeEl) beforeEl.textContent = parseFloat(before).toFixed(1) + '°C';
        if (afterEl) afterEl.textContent = parseFloat(after).toFixed(1) + '°C';
    }
    if (timeEl) timeEl.textContent = toVnDate(tsMs);

    overlay.classList.remove('visible');
    void overlay.offsetWidth;
    overlay.classList.add('visible');
}

function _onShockDialogConfirm() {
    var overlay = document.getElementById('shock-dialog-overlay');
    if (overlay) overlay.classList.remove('visible');

    if (_shockDialogCurrentKey && _shockDialogCurrentType) {
        var basePath = (_shockDialogCurrentType === 'ph' ? SHOCK_PH_PATH() : SHOCK_TEMP_PATH()) +
            '/' + _shockDialogCurrentKey + '/is_read';
        var relPath = basePath.replace('devices/' + DEVICE_ID + '/', '');
        setRef(relPath, true).catch(e => console.warn('[shock] mark read failed:', e));

        var entry = _shockEntries.find(function(e) {
            return e.key === _shockDialogCurrentKey && e.type === _shockDialogCurrentType;
        });
        if (entry) entry.is_read = true;
        _renderShockLog();
        _updateShockBadge();
    }
    _shockDialogCurrentKey = null;
    _shockDialogCurrentType = null;
}

async function _loadShockEvents() {
    await Promise.all([_loadShockType('ph'), _loadShockType('temp')]);
    _shockEntries.sort(function(a, b) { return b.tsMs - a.tsMs; });
    _renderShockLog();
    _updateShockBadge();
    _checkShowShockDialog();
}

async function _loadShockType(type) {
    var path = type === 'ph' ? SHOCK_PH_PATH() : SHOCK_TEMP_PATH();
    try {
        var snap = await fbGet(fbRef(db, path));
        if (!snap.exists()) return;
        snap.forEach(function(child) { _upsertShockEntry(child.key, type, child.val()); });
    } catch (e) { console.warn('[shock] load error:', type, e); }
}

function _upsertShockEntry(key, type, v) {
    var idx = _shockEntries.findIndex(function(e) { return e.key === key && e.type === type; });
    var entry = {
        key,
        type,
        before: type === 'ph' ? v.ph_before : v.temp_before,
        after: type === 'ph' ? v.ph_after : v.temp_after,
        tsMs: parseInt(key) * 1000,
        is_read: !!v.is_read,
    };
    if (idx >= 0) _shockEntries[idx] = entry;
    else _shockEntries.push(entry);
}

function _startShockRealtime() {
    _startShockRealtimeType('ph');
    _startShockRealtimeType('temp');
}

function _startShockRealtimeType(type) {
    var path = type === 'ph' ? SHOCK_PH_PATH() : SHOCK_TEMP_PATH();
    var q = fbQuery(fbRef(db, path), orderByKey());
    var _seenKeys = new Set(_shockEntries.filter(e => e.type === type).map(e => e.key));
    onChildAdded(q, function(child) {
        var isNew = !_seenKeys.has(child.key);
        _seenKeys.add(child.key);
        _upsertShockEntry(child.key, type, child.val());
        _shockEntries.sort(function(a, b) { return b.tsMs - a.tsMs; });
        _renderShockLog();
        _updateShockBadge();
        if (isNew && !child.val().is_read) {
            var entry = _shockEntries.find(function(e) {
                return e.key === child.key && e.type === type;
            });
            if (entry) _showShockDialog(entry.key, entry.type, entry.before, entry.after, entry.tsMs);
        }
    });
}

function _checkShowShockDialog() {
    if (_shockEntries.length === 0) return;
    var newest = _shockEntries[0];
    if (!newest.is_read)
        _showShockDialog(newest.key, newest.type, newest.before, newest.after, newest.tsMs);
}

function _renderShockLog() {
    var tbody = document.getElementById('shock-log-body');
    if (!tbody) return;
    if (_shockEntries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:16px 0;font-size:0.75rem">Chưa có sự kiện shock</td></tr>';
        return;
    }
    tbody.innerHTML = _shockEntries.map(function(e) {
        var typeIcon = e.type === 'ph' ? '⚗' : '🌡';
        var typeLbl = e.type === 'ph' ? 'pH' : 'Nhiệt';
        var beforeStr = e.type === 'ph' ?
            parseFloat(e.before).toFixed(2) :
            parseFloat(e.before).toFixed(1) + '°';
        var afterStr = e.type === 'ph' ?
            parseFloat(e.after).toFixed(2) :
            parseFloat(e.after).toFixed(1) + '°';
        var delta = parseFloat(e.after) - parseFloat(e.before);
        var deltaStr = (delta > 0 ? '+' : '') + (e.type === 'ph' ? delta.toFixed(2) : delta.toFixed(1));
        var deltaCls = delta < 0 ? 'shock-delta-down' : 'shock-delta-up';
        var unread = !e.is_read;
        var rowCls = unread ? 'shock-log-row unread' : 'shock-log-row';
        var dotHtml = unread ?
            '<span class="log-dot warn" style="flex-shrink:0"></span>' :
            '<span class="log-dot" style="background:var(--text-dim);opacity:0.3;flex-shrink:0"></span>';
        return '<tr class="' + rowCls + '" data-key="' + e.key + '" data-type="' + e.type + '">' +
            '<td>' + dotHtml + '</td>' +
            '<td class="mono" style="font-size:0.72rem">' + toVnDate(e.tsMs) + '</td>' +
            '<td><span class="shock-type-chip shock-type-' + e.type + '">' + typeIcon + ' ' + typeLbl + '</span></td>' +
            '<td class="mono" style="font-size:0.72rem">' + beforeStr + ' → ' + afterStr + '</td>' +
            '<td class="mono ' + deltaCls + '" style="font-size:0.72rem">' + deltaStr + '</td>' +
            '</tr>';
    }).join('');

    tbody.querySelectorAll('tr.shock-log-row').forEach(function(row) {
        row.addEventListener('click', function() {
            var key = row.dataset.key;
            var type = row.dataset.type;
            var entry = _shockEntries.find(function(e) { return e.key === key && e.type === type; });
            if (entry && !entry.is_read)
                _showShockDialog(entry.key, entry.type, entry.before, entry.after, entry.tsMs);
        });
    });
}

function _updateShockBadge() {
    var unread = _shockEntries.filter(function(e) { return !e.is_read; }).length;
    var badge = document.getElementById('shock-log-badge');
    if (!badge) return;
    badge.textContent = unread;
    badge.classList.toggle('hidden', unread === 0);
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

    var rawTs = (d.last_run_ts && d.last_run_ts > 0) ? d.last_run_ts : null;
    var rawDay = (d.last_run && d.last_run > 0) ? d.last_run : null;

    if (rawTs) {
        document.getElementById('wc-last-run').textContent =
            'Lần cuối: ' + toVnDate(rawTs * 1000);
    } else if (rawDay) {
        var ts2 = rawDay > 1000000000 ? rawDay * 1000 : rawDay * 86400 * 1000;
        var isUnixSec = rawDay > 1000000000;
        document.getElementById('wc-last-run').textContent =
            'Lần cuối: ' + (isUnixSec ? toVnDate(ts2) : toVnDateOnly(ts2));
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
// SAFETY LOG
// ================================================================
const CRITICAL_EVENTS = ['THERMAL_CUTOFF', 'EMERGENCY_COOL'];
var _safetyEntries = [];
var _safetyPanelOpen = false;

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

async function _loadSafetyEvents() {
    try {
        var snap = await fbGet(fbRef(db, SAFETY_FB_PATH()));
        if (!snap.exists()) { _renderSafetyLog(); return; }
        snap.forEach(function(child) { _upsertSafetyEntry(child.key, child.val()); });
        _safetyEntries.sort(function(a, b) { return b.tsMs - a.tsMs; });
        _renderSafetyLog();
        _updateSafetyBadge();
    } catch (e) { console.warn('[safety] load error:', e); }
}

function _upsertSafetyEntry(key, v) {
    var idx = _safetyEntries.findIndex(function(e) { return e.key === key; });
    var entry = { key, event: v.event, tsMs: parseInt(key) * 1000, is_read: !!v.is_read };
    if (idx >= 0) _safetyEntries[idx] = entry;
    else _safetyEntries.push(entry);
}

function _startSafetyRealtime() {
    var q = fbQuery(fbRef(db, SAFETY_FB_PATH()), orderByKey());
    var _seenKeys = new Set(_safetyEntries.map(e => e.key));
    onChildAdded(q, function(child) {
        var isNew = !_seenKeys.has(child.key);
        _seenKeys.add(child.key);
        _upsertSafetyEntry(child.key, child.val());
        _safetyEntries.sort(function(a, b) { return b.tsMs - a.tsMs; });
        _renderSafetyLog();
        if (isNew) _updateSafetyBadge();
    });
}

function _renderSafetyLog() {
    var tbody = document.getElementById('safety-log-body');
    if (!tbody) return;
    if (_safetyEntries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-dim);padding:16px 0;font-size:0.75rem">Chưa có sự kiện</td></tr>';
        return;
    }
    tbody.innerHTML = _safetyEntries.map(function(e) {
        var isCrit = CRITICAL_EVENTS.includes(e.event);
        var dotCls = isCrit ? 'log-dot critical' : 'log-dot warn';
        var unread = !e.is_read;
        var rowStyle = unread ? ' style="font-weight:600"' : ' style="opacity:0.7"';
        var unreadDot = unread ? '<span class="safety-unread-dot"></span>' : '';
        var valCell = isCrit ?
            '<td class="event-val" style="color:var(--accent-err);font-size:0.68rem;font-weight:600">CRITICAL</td>' :
            '<td class="event-val"></td>';
        return '<tr' + rowStyle + '>' +
            '<td><span class="' + dotCls + '"></span>' + unreadDot + '</td>' +
            '<td>' + toVnDate(e.tsMs) + '</td>' +
            '<td class="event-name">' + fmtEventName(e.event) + '</td>' +
            valCell + '</tr>';
    }).join('');
}

function _updateSafetyBadge() {
    var unread = _safetyEntries.filter(function(e) { return !e.is_read; }).length;
    var badge = document.getElementById('log-count-badge');
    if (!badge) return;
    badge.textContent = unread;
    badge.classList.toggle('hidden', unread === 0);
}

function _markAllSafetyRead() {
    var unreadEntries = _safetyEntries.filter(function(e) { return !e.is_read; });
    if (unreadEntries.length === 0) return;
    unreadEntries.forEach(function(e) {
        e.is_read = true;
        setRef('history/last_safety_event/' + e.key + '/is_read', true)
            .catch(function(err) { console.warn('[safety] mark read failed:', err); });
    });
    _renderSafetyLog();
    _updateSafetyBadge();
}

function toggleSafetyLog() {
    var panel = document.getElementById('safety-log-panel');
    if (!panel) return;
    _safetyPanelOpen = !_safetyPanelOpen;
    panel.classList.toggle('open', _safetyPanelOpen);
    var hint = document.getElementById('safety-log-toggle-hint');
    if (hint) hint.textContent = _safetyPanelOpen ?
        '▲ thu gọn' : '▼ nhấn để xem & đánh dấu đã đọc';
    if (_safetyPanelOpen) _markAllSafetyRead();
}
window.toggleSafetyLog = toggleSafetyLog;

// ================================================================
// INJECT CSS sensor-broken
// ================================================================
function injectSensorBrokenStyles() {
    if (document.getElementById('sensor-broken-style')) return;
    const style = document.createElement('style');
    style.id = 'sensor-broken-style';
    style.textContent = `
        .card.sensor-broken {
            border: 1px solid rgba(248,113,113,0.45) !important;
            background: rgba(248,113,113,0.04) !important;
            position: relative !important;
            overflow: hidden !important;
            isolation: isolate !important;
        }
        .card.sensor-broken::before {
            content: '';
            position: absolute; inset: 0;
            background: repeating-linear-gradient(
                -45deg, transparent, transparent 6px,
                rgba(248,113,113,0.04) 6px, rgba(248,113,113,0.04) 12px
            );
            pointer-events: none; z-index: 0;
            animation: broken-stripe 8s linear infinite;
        }
        @keyframes broken-stripe {
            from { background-position: 0 0; }
            to   { background-position: 24px 24px; }
        }
        .sensor-broken-overlay {
            position: absolute !important; inset: 0 !important;
            display: flex; flex-direction: column;
            align-items: center; justify-content: center; gap: 2px;
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
            background: rgba(255,255,255,0.55);
            z-index: 9999 !important;
            border-radius: inherit;
            animation: broken-fade-in 0.3s ease;
        }
        @keyframes broken-fade-in {
            from { opacity: 0; transform: scale(0.97); }
            to   { opacity: 1; transform: scale(1); }
        }
        .broken-icon { font-size:1.4rem; animation: broken-pulse 1.4s ease-in-out infinite; }
        @keyframes broken-pulse {
            0%,100% { opacity:1; transform:scale(1); }
            50%     { opacity:0.6; transform:scale(0.92); }
        }
        .broken-title { font-size:0.8rem; font-weight:700; color:var(--accent-err,#f87171); letter-spacing:0.04em; }
        .broken-sub   { font-size:0.68rem; color:var(--text-sub,#94a3b8); margin-top:1px; }
        .broken-sub strong { color:var(--accent-err,#f87171); }
        .broken-hint  { font-size:0.64rem; color:var(--text-dim,#64748b); margin-top:3px; }
        .source-badge.error-badge {
            background:rgba(248,113,113,0.18); color:var(--accent-err,#f87171);
            border:1px solid rgba(248,113,113,0.35); font-weight:700;
            animation: broken-pulse 1.4s ease-in-out infinite;
        }
    `;
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
    listenRef('ph_session', updatePhSession); // ← pH từ session
    listenRef('relay_state', updateRelayState);
    listenRef('water_change', updateWaterChange);
    listenRef('settings/water_schedule', updateWaterSchedule);
    listenRef('analytics', updateAnalytics);

    _initPhSensorErrorListener();

    await _loadShockEvents();
    _startShockRealtime();

    await _loadSafetyEvents();
    _startSafetyRealtime();

    startStalenessWatcher();

    onConnectionChange(function(connected) {
        document.getElementById('banner-offline')
            .classList.toggle('visible', !connected);
    });

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
        startPolling();
    }).catch(function(e) {
        console.warn('[dashboard] fetchHistory failed:', e);
        startPolling();
    });
})();