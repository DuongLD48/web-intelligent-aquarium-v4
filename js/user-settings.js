// ================================================================
// user-settings.js — Intelligent Aquarium v7.0
// ================================================================

import { listenRef, setRef, updateRef, onConnectionChange, requireAuth, doLogout } from './firebase-init.js';

// ================================================================
// DEFAULTS
// ================================================================
var DEFAULTS_CONFIG = {
    temp_min: 25.0,
    temp_max: 28.0,
    ph_min: 6.5,
    ph_max: 7.5,
    tds_target: 300.0,
    tds_tolerance: 50.0,
    pid_kp: 1.0,
    pid_ki: 0.1,
    pid_kd: 0.05,
};
var DEFAULTS_SCHEDULE = {
    enabled: false,
    hour: 6,
    minute: 0,
    pump_out_sec: 30,
    pump_in_sec: 60,
};

// ================================================================
// SAFETY THRESHOLDS
// ================================================================
const SAFE_RANGES = {
    temp_min: { min: 18, max: 30, unit: '°C', label: 'Nhiệt độ Min' },
    temp_max: { min: 20, max: 34, unit: '°C', label: 'Nhiệt độ Max' },
    ph_min: { min: 6.0, max: 7.5, unit: '', label: 'pH Min' },
    ph_max: { min: 6.5, max: 8.5, unit: '', label: 'pH Max' },
    tds_target: { min: 50, max: 800, unit: ' ppm', label: 'TDS Mục tiêu' },
    tds_tolerance: { min: 10, max: 200, unit: ' ppm', label: 'TDS Dung sai' },
    pump_out_sec: { min: 10, max: 600, unit: 's', label: 'Bơm ra' },
    pump_in_sec: { min: 10, max: 600, unit: 's', label: 'Bơm vào' },
};

// ================================================================
// TOOLTIPS
// ================================================================
const TOOLTIPS = {
    'inp-temp-min': 'Ngưỡng dưới. Heater bật ngay khi nhiệt độ thực < temp_min, tắt khi ≥ temp_max.',
    'inp-temp-max': 'Ngưỡng trên. Cooler bật ngay khi nhiệt độ thực > temp_max, tắt khi ≤ temp_min.',
    'inp-ph-min': 'pH thấp nhất cho phép. Dưới ngưỡng này bơm pH-Up sẽ kích hoạt.',
    'inp-ph-max': 'pH cao nhất cho phép. Vượt ngưỡng này bơm pH-Down sẽ kích hoạt.',
    'inp-tds-target': 'Nồng độ khoáng chất mong muốn (ppm). Giá trị lý tưởng cho loài cá.',
    'inp-tds-tol': 'Dung sai TDS ±ppm. Ví dụ target=300, tol=50 → dải chấp nhận: 250–350 ppm.',
    'inp-kp': 'Proportional gain. Giá trị cao → phản ứng nhanh hơn nhưng dễ dao động.',
    'inp-ki': 'Integral gain. Giúp triệt tiêu sai số tĩnh, nhưng cao quá gây overshoot.',
    'inp-kd': 'Derivative gain. Giảm dao động bằng cách dự đoán xu hướng thay đổi pH.',
    'inp-hour': 'Giờ thực hiện thay nước tự động hàng ngày (theo giờ thiết bị).',
    'inp-minute': 'Phút thực hiện thay nước tự động.',
    'inp-pump-out': 'Thời gian bơm nước ra (giây). Xác định lượng nước được thay thế.',
    'inp-pump-in': 'Thời gian bơm nước vào (giây). Nên ≥ thời gian bơm ra để bù đủ nước.',
};

// ================================================================
// STATE
// ================================================================
let currentConfig = {};
let currentSchedule = {};
let formConfig = {};
let formSchedule = {};
let scheduleEnabled = false;
let wcState = 'IDLE';

// ================================================================
// INIT
// ================================================================
(async function init() {
    await requireAuth();
    buildHourOptions();
    buildMinuteOptions();
    attachTooltips();
    attachInputListeners();

    listenRef('settings/config', onConfigSnap);
    listenRef('water_change', onWaterChangeSnap);
    listenRef('settings/water_schedule', onWaterScheduleSnap);
    listenRef('status', onStatusSnap);

    // Connection banner — không dùng dynamic import nữa
    onConnectionChange(function(connected) {
        document.getElementById('banner-offline')
            .classList.toggle('visible', !connected);
    });

    window.addEventListener('beforeunload', function(e) {
        if (isDirty()) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
})();

// ================================================================
// FIREBASE SNAPSHOTS
// ================================================================
function onStatusSnap(snap) {
    if (!snap.exists()) return;
    // Khi có data từ status → thiết bị đang online
    document.getElementById('dot-online').className = 'status-dot online';
    document.getElementById('txt-online').textContent = 'Online';
}

function onConfigSnap(snap) {
    // Nếu chưa có data trên Firebase thì dùng DEFAULTS
    var d = snap.exists() ? snap.val() : Object.assign({}, DEFAULTS_CONFIG);
    console.log('[Settings] onConfigSnap:', d);
    currentConfig = Object.assign({}, DEFAULTS_CONFIG, d);
    formConfig = Object.assign({}, currentConfig);

    setVal('inp-temp-min', currentConfig.temp_min);
    setVal('inp-temp-max', currentConfig.temp_max);
    setVal('inp-ph-min', currentConfig.ph_min);
    setVal('inp-ph-max', currentConfig.ph_max);
    setVal('inp-tds-target', currentConfig.tds_target);
    setVal('inp-tds-tol', currentConfig.tds_tolerance);
    setVal('inp-kp', currentConfig.pid_kp);
    setVal('inp-ki', currentConfig.pid_ki);
    setVal('inp-kd', currentConfig.pid_kd);

    updatePreviews();
    updateDirtyState();
    updateFieldHighlights();
    checkSafetyAlerts();
}

function onWaterChangeSnap(snap) {
    if (!snap.exists()) return;
    const d = snap.val();

    wcState = (d.state || 'IDLE').toUpperCase();
    const btn = document.getElementById('btn-water-now');
    const stateEl = document.getElementById('wc-state-info');
    btn.disabled = wcState !== 'IDLE';

    if (wcState === 'PUMPING_OUT') {
        stateEl.textContent = '⏳ Đang bơm nước ra...';
        stateEl.style.color = 'var(--accent-temp)';
    } else if (wcState === 'PUMPING_IN') {
        stateEl.textContent = '⏳ Đang bơm nước vào...';
        stateEl.style.color = 'var(--accent-ok)';
    } else {
        stateEl.textContent = '';
    }

    // Ưu tiên last_run_ts (Unix timestamp thực từ NTP)
    var rawTs2 = (d.last_run_ts && d.last_run_ts > 0) ? d.last_run_ts : null;
    var rawDay2 = (d.last_run && d.last_run > 0) ? d.last_run : null;
    if (rawTs2) {
        document.getElementById('wc-last-run').textContent =
            'Lần cuối: ' + fmtTimestampVN(rawTs2 * 1000);
    } else if (rawDay2) {
        var ts3 = rawDay2 > 1000000000 ? rawDay2 * 1000 : rawDay2 * 86400 * 1000;
        document.getElementById('wc-last-run').textContent =
            'Lần cuối: ' + fmtTimestampVN(ts3);
    }

    // Schedule fields đọc từ settings/water_schedule (xem onWaterScheduleSnap)
}


function onWaterScheduleSnap(snap) {
    var d = snap.exists() ? snap.val() : {};
    console.log('[Settings] onWaterScheduleSnap:', d);
    currentSchedule = {
        enabled: !!d.enabled,
        hour: d.hour || DEFAULTS_SCHEDULE.hour,
        minute: d.minute || DEFAULTS_SCHEDULE.minute,
        pump_out_sec: d.pump_out_sec || DEFAULTS_SCHEDULE.pump_out_sec,
        pump_in_sec: d.pump_in_sec || DEFAULTS_SCHEDULE.pump_in_sec,
    };
    formSchedule = Object.assign({}, currentSchedule);
    scheduleEnabled = currentSchedule.enabled;

    applyScheduleToggleUI(scheduleEnabled);
    setSelectVal('inp-hour', currentSchedule.hour);
    setSelectVal('inp-minute', currentSchedule.minute);
    setVal('inp-pump-out', currentSchedule.pump_out_sec);
    setVal('inp-pump-in', currentSchedule.pump_in_sec);

    updateSchedulePreviews();
    updateDirtyState();
    updateFieldHighlights();
    checkSafetyAlerts();
}

// ================================================================
// BUILD HELPERS
// ================================================================
function buildHourOptions() {
    const sel = document.getElementById('inp-hour');
    for (let h = 0; h < 24; h++) {
        const opt = document.createElement('option');
        opt.value = h;
        opt.textContent = String(h).padStart(2, '0') + ':00';
        sel.appendChild(opt);
    }
}

function buildMinuteOptions() {
    const sel = document.getElementById('inp-minute');
    for (let m = 0; m < 60; m++) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = String(m).padStart(2, '0');
        sel.appendChild(opt);
    }
}

function fmtSec(sec) {
    const s = parseInt(sec) || 0;
    const m = Math.floor(s / 60),
        r = s % 60;
    return m > 0 ? (m) + " phút" + (r > 0 ? ' ' + r + 's' : '') : (r) + " giây";
}

// ================================================================
// TOOLTIP
// ================================================================
function attachTooltips() {
    const tip = document.createElement('div');
    tip.id = 'global-tooltip';
    tip.className = 'field-tooltip';
    document.body.appendChild(tip);

    Object.entries(TOOLTIPS).forEach(function([id, text]) {
        const el = document.getElementById(id);
        const group = el ? el.closest('.form-group') : null;
        const label = group ? group.querySelector('.form-label') : null;
        if (!label || label.querySelector('.tooltip-icon')) return;

        const icon = document.createElement('span');
        icon.className = 'tooltip-icon';
        icon.textContent = ' ⓘ';
        label.appendChild(icon);
        icon.addEventListener('mouseenter', function() { showTooltip(icon, text); });
        icon.addEventListener('mouseleave', hideTooltip);
    });
}

function showTooltip(anchor, text) {
    const tip = document.getElementById('global-tooltip');
    const rect = anchor.getBoundingClientRect();
    tip.textContent = text;
    tip.style.left = Math.min(rect.left, window.innerWidth - 270) + 'px';
    tip.style.top = (rect.bottom + 6 + window.scrollY) + 'px';
    tip.classList.add('visible');
}

function hideTooltip() {
    document.getElementById('global-tooltip').classList.remove('visible');
}

// ================================================================
// FIELD HIGHLIGHT
// ================================================================
const FIELD_MAP = {
    'inp-temp-min': ['config', 'temp_min'],
    'inp-temp-max': ['config', 'temp_max'],
    'inp-ph-min': ['config', 'ph_min'],
    'inp-ph-max': ['config', 'ph_max'],
    'inp-tds-target': ['config', 'tds_target'],
    'inp-tds-tol': ['config', 'tds_tolerance'],
    'inp-kp': ['config', 'pid_kp'],
    'inp-ki': ['config', 'pid_ki'],
    'inp-kd': ['config', 'pid_kd'],
    'inp-pump-out': ['schedule', 'pump_out_sec'],
    'inp-pump-in': ['schedule', 'pump_in_sec'],
};

function updateFieldHighlights() {
    Object.entries(FIELD_MAP).forEach(function(entry) {
        var id = entry[0];
        var src = entry[1][0];
        var key = entry[1][1];
        const el = document.getElementById(id);
        const current = src === 'config' ? currentConfig : currentSchedule;
        const form = src === 'config' ? formConfig : formSchedule;
        if (el) el.classList.toggle('field-changed', form[key] !== undefined && form[key] !== current[key]);
    });
}

// ================================================================
// SAFETY ALERT BANNER
// ================================================================
function checkSafetyAlerts() {
    const alerts = [];

    [
        ['temp_min', parseFloat(getVal('inp-temp-min')), 'inp-temp-min'],
        ['temp_max', parseFloat(getVal('inp-temp-max')), 'inp-temp-max'],
        ['ph_min', parseFloat(getVal('inp-ph-min')), 'inp-ph-min'],
        ['ph_max', parseFloat(getVal('inp-ph-max')), 'inp-ph-max'],
        ['tds_target', parseInt(getVal('inp-tds-target')), 'inp-tds-target'],
        ['tds_tolerance', parseInt(getVal('inp-tds-tol')), 'inp-tds-tol'],
        ['pump_out_sec', parseInt(getVal('inp-pump-out')), 'inp-pump-out'],
        ['pump_in_sec', parseInt(getVal('inp-pump-in')), 'inp-pump-in'],
    ].forEach(function([key, val, id]) {
        const r = SAFE_RANGES[key];
        const el = document.getElementById(id);
        if (!r || isNaN(val)) return;
        if (val < r.min || val > r.max) {
            alerts.push("⚠ " + (r.label) + ": " + (val) + (r.unit) + " — ngoài vùng an toàn (" + (r.min) + "–" + (r.max) + (r.unit) + ")");
            if (el) el.classList.add('field-alert');
        } else {
            if (el) el.classList.remove('field-alert');
        }
    });

    let banner = document.getElementById('safety-alert-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'safety-alert-banner';
        banner.className = 'safety-alert-banner';
        document.querySelector('.settings-wrapper').prepend(banner);
    }
    banner.classList.toggle('visible', alerts.length > 0);
    banner.innerHTML = alerts.map(function(a) { return '<div>' + a + '</div>'; }).join('');
}

// ================================================================
// INPUT LISTENERS
// ================================================================
function attachInputListeners() {
    ['inp-temp-min', 'inp-temp-max', 'inp-ph-min', 'inp-ph-max',
        'inp-tds-target', 'inp-tds-tol', 'inp-kp', 'inp-ki', 'inp-kd'
    ].forEach(function(id) {
        var _tmp = document.getElementById(id);
        if (_tmp) _tmp.addEventListener('input', function() {
            syncFormConfig();
            updatePreviews();
            updateDirtyState();
            updateFieldHighlights();
            checkSafetyAlerts();
        });
    });

    ['inp-hour', 'inp-minute', 'inp-pump-out', 'inp-pump-in'].forEach(function(id) {
        var _tmp = document.getElementById(id);
        if (_tmp) _tmp.addEventListener('input', function() {
            syncFormSchedule();
            updateSchedulePreviews();
            updateDirtyState();
            updateFieldHighlights();
            checkSafetyAlerts();
        });
    });
}

function syncFormConfig() {
    formConfig.temp_min = parseFloat(getVal('inp-temp-min'));
    formConfig.temp_max = parseFloat(getVal('inp-temp-max'));
    formConfig.ph_min = parseFloat(getVal('inp-ph-min'));
    formConfig.ph_max = parseFloat(getVal('inp-ph-max'));
    formConfig.tds_target = parseInt(getVal('inp-tds-target'));
    formConfig.tds_tolerance = parseInt(getVal('inp-tds-tol'));
    formConfig.pid_kp = parseFloat(getVal('inp-kp'));
    formConfig.pid_ki = parseFloat(getVal('inp-ki'));
    formConfig.pid_kd = parseFloat(getVal('inp-kd'));
}

function syncFormSchedule() {
    formSchedule.enabled = scheduleEnabled;
    formSchedule.hour = parseInt(getVal('inp-hour'));
    formSchedule.minute = parseInt(getVal('inp-minute'));
    formSchedule.pump_out_sec = parseInt(getVal('inp-pump-out'));
    formSchedule.pump_in_sec = parseInt(getVal('inp-pump-in'));
}

// ================================================================
// PREVIEWS
// ================================================================
function updatePreviews() {
    const tMin = parseFloat(getVal('inp-temp-min'));
    const tMax = parseFloat(getVal('inp-temp-max'));
    if (!isNaN(tMin) && !isNaN(tMax) && tMax > tMin)
        document.getElementById('prev-temp').textContent =
        "→ Heater bật < " + tMin.toFixed(1) + "°C  |  Cooler bật > " + tMax.toFixed(1) + "°C";

    const pMin = parseFloat(getVal('inp-ph-min'));
    const pMax = parseFloat(getVal('inp-ph-max'));
    if (!isNaN(pMin) && !isNaN(pMax) && pMax > pMin)
        document.getElementById('prev-ph').textContent =
        "→ Mục tiêu " + (((pMin + pMax) / 2).toFixed(2)) + " ± " + (((pMax - pMin) / 2).toFixed(2));

    const tgt = parseInt(getVal('inp-tds-target'));
    const tol = parseInt(getVal('inp-tds-tol'));
    if (!isNaN(tgt) && !isNaN(tol) && tol > 0)
        document.getElementById('prev-tds').textContent =
        "→ Dải chấp nhận " + (tgt - tol) + "–" + (tgt + tol) + " ppm";
}

function updateSchedulePreviews() {
    const h = parseInt(getVal('inp-hour')) || 0;
    const m = parseInt(getVal('inp-minute')) || 0;
    document.getElementById('prev-schedule').textContent =
        "→ Mỗi ngày lúc " + (String(h).padStart(2, '0')) + ":" + (String(m).padStart(2, '0'));
    const pOut = parseInt(getVal('inp-pump-out'));
    const pIn = parseInt(getVal('inp-pump-in'));
    if (!isNaN(pOut)) document.getElementById('prev-pump-out').textContent = fmtSec(pOut);
    if (!isNaN(pIn)) document.getElementById('prev-pump-in').textContent = fmtSec(pIn);
}

// ================================================================
// VALIDATION
// ================================================================
function validateConfig() {
    let ok = true;

    const tMin = parseFloat(formConfig.temp_min);
    const tMax = parseFloat(formConfig.temp_max);
    const tempOk = !isNaN(tMin) && !isNaN(tMax) && tMax - tMin >= 0.5 && tMin >= 15 && tMax <= 38;
    setErr('err-temp', !tempOk);
    setInputErr('inp-temp-min', !tempOk);
    if (!tempOk) ok = false;

    const pMin = parseFloat(formConfig.ph_min);
    const pMax = parseFloat(formConfig.ph_max);
    const phOk = !isNaN(pMin) && !isNaN(pMax) && pMax - pMin >= 0.3 && pMin >= 5.0 && pMax <= 9.5;
    setErr('err-ph', !phOk);
    setInputErr('inp-ph-min', !phOk);
    if (!phOk) ok = false;

    const tgt = parseInt(formConfig.tds_target);
    const tol = parseInt(formConfig.tds_tolerance);
    const tdsOk = !isNaN(tgt) && !isNaN(tol) && tgt >= 50 && tgt <= 2000 && tol >= 10;
    setErr('err-tds', !tdsOk);
    setInputErr('inp-tds-target', !tdsOk);
    if (!tdsOk) ok = false;

    const pOut = parseInt(formSchedule.pump_out_sec);
    const pIn = parseInt(formSchedule.pump_in_sec);
    const pmpOk = !isNaN(pOut) && !isNaN(pIn) && pOut >= 10 && pIn >= 10;
    setErr('err-pump', !pmpOk);
    setInputErr('inp-pump-out', !pmpOk);
    setInputErr('inp-pump-in', !pmpOk);
    if (!pmpOk) ok = false;

    return ok;
}

// ================================================================
// DIRTY STATE
// ================================================================
function isDirty() {
    return JSON.stringify(formConfig) !== JSON.stringify(currentConfig) ||
        JSON.stringify(formSchedule) !== JSON.stringify(currentSchedule) ||
        scheduleEnabled !== !!currentSchedule.enabled;
}

function countDirtyFields() {
    let n = 0;
    ['temp_min', 'temp_max', 'ph_min', 'ph_max', 'tds_target', 'tds_tolerance',
        'pid_kp', 'pid_ki', 'pid_kd'
    ].forEach(function(k) {
        if (formConfig[k] !== currentConfig[k]) n++;
    });
    ['hour', 'minute', 'pump_out_sec', 'pump_in_sec'].forEach(function(k) {
        if (formSchedule[k] !== currentSchedule[k]) n++;
    });
    if (scheduleEnabled !== !!currentSchedule.enabled) n++;
    return n;
}

function updateDirtyState() {
    const dirty = isDirty();
    document.getElementById('dirty-indicator').classList.toggle('hidden', !dirty);
    if (dirty) document.getElementById('dirty-count').textContent = countDirtyFields();
    document.getElementById('btn-save').disabled = !dirty;
}

// ================================================================
// SCHEDULE TOGGLE
// ================================================================
window.toggleSchedule = function() {
    scheduleEnabled = !scheduleEnabled;
    applyScheduleToggleUI(scheduleEnabled);
    syncFormSchedule();
    updateDirtyState();
};

function applyScheduleToggleUI(enabled) {
    document.getElementById('toggle-schedule').classList.toggle('on', enabled);
    const inputs = document.getElementById('schedule-inputs');
    inputs.style.opacity = enabled ? '1' : '0.3';
    inputs.style.pointerEvents = enabled ? 'auto' : 'none';
    document.getElementById('lbl-schedule').textContent =
        enabled ? 'Lịch tự động: Bật' : 'Lịch tự động: Tắt';
}

// ================================================================
// PID COLLAPSIBLE
// ================================================================
window.togglePid = function() {
    const body = document.getElementById('pid-body');
    const open = body.classList.toggle('open');
    document.getElementById('pid-trigger').classList.toggle('open', open);
    document.getElementById('pid-arrow').textContent = open ? '▼' : '▶';
};

// ================================================================
// SAVE
// ================================================================
window.saveAll = function() {
    syncFormConfig();
    syncFormSchedule();

    if (!validateConfig()) {
        showToast('Vui lòng kiểm tra lại các giá trị', 'error');
        return;
    }

    var banner = document.getElementById('safety-alert-banner');
    if (banner && banner.classList.contains('visible')) {
        if (!confirm('⚠ Một số giá trị nằm ngoài vùng an toàn. Vẫn muốn lưu?')) return;
    }

    var btn = document.getElementById('btn-save');
    btn.disabled = true;
    btn.textContent = 'Đang lưu...';

    updateRef('settings/config', {
        temp_min: formConfig.temp_min,
        temp_max: formConfig.temp_max,
        ph_min: formConfig.ph_min,
        ph_max: formConfig.ph_max,
        tds_target: formConfig.tds_target,
        tds_tolerance: formConfig.tds_tolerance,
        pid_kp: formConfig.pid_kp,
        pid_ki: formConfig.pid_ki,
        pid_kd: formConfig.pid_kd,
    }).then(function() {
        return updateRef('settings/water_schedule', {
            enabled: scheduleEnabled,
            hour: formSchedule.hour,
            minute: formSchedule.minute,
            pump_out_sec: formSchedule.pump_out_sec,
            pump_in_sec: formSchedule.pump_in_sec,
        });
    }).then(function() {
        currentConfig = Object.assign({}, formConfig);
        currentSchedule = Object.assign({}, formSchedule, { enabled: scheduleEnabled });
        updateDirtyState();
        updateFieldHighlights();
        showToast('Đã lưu thành công ✓', 'success');
    }).catch(function(err) {
        console.error('Save error:', err);
        showToast('Lưu thất bại: ' + err.message, 'error');
    }).finally(function() {
        btn.textContent = 'Lưu';
        updateDirtyState();
    });
};

// ================================================================
// REVERT
// ================================================================
// ================================================================
// RESET TO DEFAULT
// ================================================================
window.resetToDefault = function() {
    if (!confirm('Khôi phục tất cả cài đặt về mặc định? Gõ OK để xác nhận.')) return;
    var btn = document.getElementById('btn-save');
    btn.disabled = true;
    btn.textContent = 'Đang khôi phục...';
    updateRef('settings/config', {
        temp_min: DEFAULTS_CONFIG.temp_min,
        temp_max: DEFAULTS_CONFIG.temp_max,
        ph_min: DEFAULTS_CONFIG.ph_min,
        ph_max: DEFAULTS_CONFIG.ph_max,
        tds_target: DEFAULTS_CONFIG.tds_target,
        tds_tolerance: DEFAULTS_CONFIG.tds_tolerance,
        pid_kp: DEFAULTS_CONFIG.pid_kp,
        pid_ki: DEFAULTS_CONFIG.pid_ki,
        pid_kd: DEFAULTS_CONFIG.pid_kd,
    }).then(function() {
        return updateRef('settings/water_schedule', {
            enabled: DEFAULTS_SCHEDULE.enabled,
            hour: DEFAULTS_SCHEDULE.hour,
            minute: DEFAULTS_SCHEDULE.minute,
            pump_out_sec: DEFAULTS_SCHEDULE.pump_out_sec,
            pump_in_sec: DEFAULTS_SCHEDULE.pump_in_sec,
        });
    }).then(function() {
        showToast('Đã khôi phục mặc định ✓', 'success');
    }).catch(function(err) {
        showToast('Khôi phục thất bại: ' + err.message, 'error');
    }).finally(function() {
        btn.textContent = 'Lưu';
        updateDirtyState();
    });
};

window.revertChanges = function() {
    formConfig = Object.assign({}, currentConfig);
    formSchedule = Object.assign({}, currentSchedule);
    scheduleEnabled = !!currentSchedule.enabled;

    setVal('inp-temp-min', currentConfig.temp_min);
    setVal('inp-temp-max', currentConfig.temp_max);
    setVal('inp-ph-min', currentConfig.ph_min);
    setVal('inp-ph-max', currentConfig.ph_max);
    setVal('inp-tds-target', currentConfig.tds_target);
    setVal('inp-tds-tol', currentConfig.tds_tolerance);
    setVal('inp-kp', currentConfig.pid_kp);
    setVal('inp-ki', currentConfig.pid_ki);
    setVal('inp-kd', currentConfig.pid_kd);

    setSelectVal('inp-hour', currentSchedule.hour || 8);
    setSelectVal('inp-minute', currentSchedule.minute || 0);
    setVal('inp-pump-out', currentSchedule.pump_out_sec || 30);
    setVal('inp-pump-in', currentSchedule.pump_in_sec || 60);

    applyScheduleToggleUI(scheduleEnabled);
    updatePreviews();
    updateSchedulePreviews();
    updateDirtyState();
    updateFieldHighlights();
    checkSafetyAlerts();

    ['err-temp', 'err-ph', 'err-tds', 'err-pump'].forEach(function(id) {
        var _e1 = document.getElementById(id);
        if (_e1) _e1.classList.remove('visible');
    });
    ['inp-temp-min', 'inp-temp-max', 'inp-ph-min', 'inp-ph-max',
        'inp-tds-target', 'inp-tds-tol', 'inp-pump-out', 'inp-pump-in'
    ].forEach(function(id) {
        var _e2 = document.getElementById(id);
        if (_e2) _e2.classList.remove('error', 'field-alert');
    });

    showToast('Đã hoàn tác về giá trị Firebase', 'success');
};

// ================================================================
// TRIGGER WATER CHANGE
// ================================================================
window.triggerWaterChange = function() {
    if (wcState !== 'IDLE') return;
    var btn = document.getElementById('btn-water-now');
    btn.disabled = true;
    setRef('water_change/manual_trigger', true).then(function() {
        showToast('Đã gửi lệnh thay nước', 'success');
    }).catch(function(e) {
        console.error(e);
        showToast('Gửi lệnh thất bại', 'error');
        btn.disabled = false;
    });
};

// ================================================================
// TOAST
// ================================================================
function showToast(msg, type = 'success') {
    const toast = document.createElement('div');
    toast.className = "toast " + (type);
    toast.textContent = msg;
    document.getElementById('toast-container').appendChild(toast);
    setTimeout(function() { toast.remove(); }, 3200);
}

// ================================================================
// DOM HELPERS
// ================================================================
function getVal(id) { var _g = document.getElementById(id); return _g ? _g.value : ''; }

function setVal(id, val) {
    const el = document.getElementById(id);
    if (el && val !== undefined && val !== null) el.value = val;
}

function setSelectVal(id, val) {
    const el = document.getElementById(id);
    if (!el) return;
    for (const opt of el.options)
        if (parseInt(opt.value) === parseInt(val)) { opt.selected = true; break; }
}

function setErr(id, show) { var _se = document.getElementById(id); if (_se) _se.classList.toggle('visible', show); }

function setInputErr(id, show) { var _si = document.getElementById(id); if (_si) _si.classList.toggle('error', show); }

function fmtTimestampVN(epochMs) {
    const VN = 7 * 3600 * 1000;
    const d = new Date(epochMs + VN);
    const now = new Date(Date.now() + VN);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) return "hôm nay " + (hh) + ":" + (mm);
    return (String(d.getUTCDate()).padStart(2, '0')) + "/" + (String(d.getUTCMonth() + 1).padStart(2, '0')) + " " + (hh) + ":" + (mm);
}