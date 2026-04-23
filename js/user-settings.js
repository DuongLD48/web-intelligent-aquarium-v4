// ================================================================
// user-settings.js — Intelligent Aquarium v4.1
// Bỏ PID, thêm PhDose Controller config
// ================================================================

import {
    listenRef,
    updateRef,
    onConnectionChange,
    requireAuth
} from './firebase-init.js';

// ================================================================
// DEFAULTS
// ================================================================
var DEFAULTS_CONFIG = {
    temp_min: 25.0,
    temp_max: 28.0,
    ph_min: 6.5,
    ph_max: 7.5,
    tds_target: 300,
    tds_tolerance: 50,
};

var DEFAULTS_DOSE = {
    measure_interval_s: 300,
    session_duration_s: 60,
    warmup_s: 30,
    base_pulse_ms: 300,
    pulse_per_unit: 1000,
    max_pulse_ms: 3000,
};

var DEFAULTS_SCHEDULE = {
    enabled: false,
    hour: 8,
    minute: 0,
    pump_out_sec: 30,
    pump_in_sec: 60,
};

var SAFE_RANGES = {
    'inp-temp-min': { min: 18, max: 32, unit: '°C', label: 'Nhiệt độ thấp nhất' },
    'inp-temp-max': { min: 19, max: 35, unit: '°C', label: 'Nhiệt độ cao nhất' },
    'inp-ph-min': { min: 5.5, max: 8.0, unit: '', label: 'pH thấp nhất' },
    'inp-ph-max': { min: 6.0, max: 9.0, unit: '', label: 'pH cao nhất' },
    'inp-pump-out': { min: 10, max: 300, unit: 's', label: 'Bơm ra' },
    'inp-pump-in': { min: 10, max: 600, unit: 's', label: 'Bơm vào' },
};

// ================================================================
// STATE
// ================================================================
var currentConfig = {};
var currentDose = {};
var currentSchedule = {};
var formConfig = {};
var formDose = {};
var formSchedule = {};
var scheduleEnabled = false;
var wcState = 'IDLE';

// ================================================================
// INIT
// ================================================================
(async function init() {
    await requireAuth();
    buildHourOptions();
    buildMinuteOptions();
    attachInputListeners();

    listenRef('settings/config', onConfigSnap);
    listenRef('settings/ph_dose_config', onDoseSnap);
    listenRef('water_change', onWaterChangeSnap);
    listenRef('settings/water_schedule', onWaterScheduleSnap);
    listenRef('status', onStatusSnap);

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
    document.getElementById('dot-online').className = 'status-dot online';
    document.getElementById('txt-online').textContent = 'Trực tuyến';
}

function onConfigSnap(snap) {
    var d = snap.exists() ? snap.val() : {};
    currentConfig = Object.assign({}, DEFAULTS_CONFIG, d);
    formConfig = Object.assign({}, currentConfig);

    setVal('inp-temp-min', currentConfig.temp_min);
    setVal('inp-temp-max', currentConfig.temp_max);
    setVal('inp-ph-min', currentConfig.ph_min);
    setVal('inp-ph-max', currentConfig.ph_max);
    setVal('inp-tds-target', currentConfig.tds_target);
    setVal('inp-tds-tol', currentConfig.tds_tolerance);

    updatePreviews();
    updateDirtyState();
    updateFieldHighlights();
    checkSafetyAlerts();
}

function onDoseSnap(snap) {
    var d = snap.exists() ? snap.val() : {};
    currentDose = Object.assign({}, DEFAULTS_DOSE, d);
    formDose = Object.assign({}, currentDose);

    setVal('inp-measure-interval-min', Math.round(currentDose.measure_interval_s / 60));
    setVal('inp-session-duration-s', currentDose.session_duration_s);
    setVal('inp-warmup-s', currentDose.warmup_s);
    setVal('inp-base-pulse-ms', currentDose.base_pulse_ms);
    setVal('inp-pulse-per-unit', currentDose.pulse_per_unit);
    setVal('inp-max-pulse-ms', currentDose.max_pulse_ms);

    updateDosePreviews();
    updateDirtyState();
    updateFieldHighlights();
}

function onWaterChangeSnap(snap) {
    if (!snap.exists()) return;
    var d = snap.val();
    wcState = (d.state || 'IDLE').toUpperCase();

    var btn = document.getElementById('btn-water-now');
    var stateEl = document.getElementById('wc-state-info');
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

    var rawTs = (d.last_run_ts && d.last_run_ts > 0) ? d.last_run_ts : null;
    if (rawTs) {
        document.getElementById('wc-last-run').textContent =
            'Lần cuối: ' + fmtTimestampVN(rawTs * 1000);
    }
}

function onWaterScheduleSnap(snap) {
    var d = snap.exists() ? snap.val() : {};
    currentSchedule = Object.assign({}, DEFAULTS_SCHEDULE, d);
    formSchedule = pickEditableSchedule(currentSchedule);
    scheduleEnabled = !!currentSchedule.enabled;

    applyScheduleToggleUI(scheduleEnabled);
    setVal('inp-hour', currentSchedule.hour);
    setVal('inp-minute', currentSchedule.minute);
    setVal('inp-pump-out', currentSchedule.pump_out_sec);
    setVal('inp-pump-in', currentSchedule.pump_in_sec);

    updateSchedulePreviews();
    updateDirtyState();
    updateFieldHighlights();
}

// ================================================================
// SYNC FORM ← DOM
// ================================================================
function syncFormConfig() {
    formConfig.temp_min = parseFloat(getVal('inp-temp-min'));
    formConfig.temp_max = parseFloat(getVal('inp-temp-max'));
    formConfig.ph_min = parseFloat(getVal('inp-ph-min'));
    formConfig.ph_max = parseFloat(getVal('inp-ph-max'));
    formConfig.tds_target = parseInt(getVal('inp-tds-target'));
    formConfig.tds_tolerance = parseInt(getVal('inp-tds-tol'));
}

function syncFormDose() {
    var intervalMin = parseInt(getVal('inp-measure-interval-min'));
    formDose.measure_interval_s = intervalMin * 60;
    formDose.session_duration_s = parseInt(getVal('inp-session-duration-s'));
    formDose.warmup_s = parseInt(getVal('inp-warmup-s'));
    formDose.base_pulse_ms = parseInt(getVal('inp-base-pulse-ms'));
    formDose.pulse_per_unit = parseInt(getVal('inp-pulse-per-unit'));
    formDose.max_pulse_ms = parseInt(getVal('inp-max-pulse-ms'));
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
    var tMin = parseFloat(getVal('inp-temp-min'));
    var tMax = parseFloat(getVal('inp-temp-max'));
    document.getElementById('prev-temp').textContent =
        (!isNaN(tMin) && !isNaN(tMax)) ?
        '→ Bộ sưởi bật dưới ' + tMin + '°C  |  Làm mát bật trên ' + tMax + '°C' :
        '→ --';

    var pMin = parseFloat(getVal('inp-ph-min'));
    var pMax = parseFloat(getVal('inp-ph-max'));
    document.getElementById('prev-ph').textContent =
        (!isNaN(pMin) && !isNaN(pMax)) ?
        '→ Vùng an toàn [' + pMin + ' ~ ' + pMax + ']  |  mốc giữa ' + (((pMin + pMax) / 2).toFixed(2)) :
        '→ --';

    var tgt = parseInt(getVal('inp-tds-target'));
    var tol = parseInt(getVal('inp-tds-tol'));
    document.getElementById('prev-tds').textContent =
        (!isNaN(tgt) && !isNaN(tol)) ?
        '→ Mục tiêu ' + tgt + ' ± ' + tol + ' ppm  (' + (tgt - tol) + ' ~ ' + (tgt + tol) + ')' :
        '→ --';
}

function updateDosePreviews() {
    var intervalMin = parseInt(getVal('inp-measure-interval-min'));
    var sessionS = parseInt(getVal('inp-session-duration-s'));
    var warmupS = parseInt(getVal('inp-warmup-s'));
    var base = parseInt(getVal('inp-base-pulse-ms'));
    var slope = parseInt(getVal('inp-pulse-per-unit'));
    var maxMs = parseInt(getVal('inp-max-pulse-ms'));
    var pMax = parseFloat(getVal('inp-ph-max'));

    var intervalEl = document.getElementById('prev-interval-text');
    if (intervalEl && !isNaN(intervalMin))
        intervalEl.textContent = intervalMin + ' phút';

    var valid = !isNaN(base) && !isNaN(slope) && !isNaN(maxMs) &&
        base <= maxMs && !isNaN(warmupS) && !isNaN(sessionS) &&
        warmupS < sessionS;

    var prevEl = document.getElementById('prev-dose');
    if (!valid) { prevEl.textContent = '→ --'; return; }

    var pulse1 = Math.min(maxMs, base + slope * 0.2);
    var pulse2 = Math.min(maxMs, base + slope * 0.5);
    var collectS = sessionS - warmupS;
    var phRef = isNaN(pMax) ? 7.5 : pMax;

    prevEl.textContent =
        '→ Mỗi ' + intervalMin + ' phút: chờ ổn định ' + warmupS + ' giây + lấy mẫu ' + collectS + ' giây  |  ' +
        'pH=' + phRef + '+0.2 → ' + pulse1 + 'ms  |  ' +
        'pH=' + phRef + '+0.5 → ' + pulse2 + 'ms  |  tối đa ' + maxMs + 'ms';
}

function updateSchedulePreviews() {
    var pOut = parseInt(getVal('inp-pump-out'));
    var pIn = parseInt(getVal('inp-pump-in'));
    document.getElementById('prev-pump').textContent =
        (!isNaN(pOut) && !isNaN(pIn)) ?
        '→ Ra: ' + fmtSec(pOut) + '  |  Vào: ' + fmtSec(pIn) :
        '→ --';
}

// ================================================================
// VALIDATION
// ================================================================
function validateConfig() {
    var ok = true;

    var tMin = parseFloat(formConfig.temp_min);
    var tMax = parseFloat(formConfig.temp_max);
    var tempOk = !isNaN(tMin) && !isNaN(tMax) && tMax - tMin >= 0.5 && tMin >= 15 && tMax <= 38;
    setErr('err-temp', !tempOk);
    setInputErr('inp-temp-min', !tempOk);
    if (!tempOk) ok = false;

    var pMin = parseFloat(formConfig.ph_min);
    var pMax = parseFloat(formConfig.ph_max);
    var phOk = !isNaN(pMin) && !isNaN(pMax) && pMax - pMin >= 0.3 && pMin >= 5.0 && pMax <= 9.5;
    setErr('err-ph', !phOk);
    setInputErr('inp-ph-min', !phOk);
    if (!phOk) ok = false;

    var tgt = parseInt(formConfig.tds_target);
    var tol = parseInt(formConfig.tds_tolerance);
    var tdsOk = !isNaN(tgt) && !isNaN(tol) && tgt >= 50 && tgt <= 2000 && tol >= 10;
    setErr('err-tds', !tdsOk);
    setInputErr('inp-tds-target', !tdsOk);
    if (!tdsOk) ok = false;

    var base = parseInt(formDose.base_pulse_ms);
    var maxMs = parseInt(formDose.max_pulse_ms);
    var warmup = parseInt(formDose.warmup_s);
    var session = parseInt(formDose.session_duration_s);
    var iv = parseInt(formDose.measure_interval_s);
    var doseOk = !isNaN(base) && !isNaN(maxMs) && base >= 50 && maxMs >= 100 &&
        base <= maxMs && !isNaN(warmup) && !isNaN(session) &&
        warmup < session && session <= iv && iv >= 60;
    setErr('err-dose', !doseOk);
    setInputErr('inp-base-pulse-ms', !doseOk);
    if (!doseOk) ok = false;

    var pOut = parseInt(formSchedule.pump_out_sec);
    var pIn = parseInt(formSchedule.pump_in_sec);
    var pmpOk = !isNaN(pOut) && !isNaN(pIn) && pOut >= 10 && pIn >= 10;
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
        JSON.stringify(formDose) !== JSON.stringify(currentDose) ||
        JSON.stringify(formSchedule) !== JSON.stringify(pickEditableSchedule(currentSchedule)) ||
        scheduleEnabled !== !!currentSchedule.enabled;
}

function countDirtyFields() {
    var n = 0;
    var currentScheduleEditable = pickEditableSchedule(currentSchedule);
    Object.keys(currentConfig).forEach(function(k) {
        if (formConfig[k] !== currentConfig[k]) n++;
    });
    Object.keys(currentDose).forEach(function(k) {
        if (formDose[k] !== currentDose[k]) n++;
    });
    Object.keys(currentScheduleEditable).forEach(function(k) {
        if (formSchedule[k] !== currentScheduleEditable[k]) n++;
    });
    if (scheduleEnabled !== !!currentSchedule.enabled) n++;
    return n;
}

function updateDirtyState() {
    var dirty = isDirty();
    document.getElementById('dirty-indicator').classList.toggle('hidden', !dirty);
    if (dirty) document.getElementById('dirty-count').textContent = countDirtyFields();
    document.getElementById('btn-save').disabled = !dirty;
}

function updateFieldHighlights() {
    var cfgMap = {
        'inp-temp-min': 'temp_min',
        'inp-temp-max': 'temp_max',
        'inp-ph-min': 'ph_min',
        'inp-ph-max': 'ph_max',
        'inp-tds-target': 'tds_target',
        'inp-tds-tol': 'tds_tolerance',
    };
    Object.keys(cfgMap).forEach(function(id) {
        var k = cfgMap[id];
        var el = document.getElementById(id);
        if (el) el.classList.toggle('field-changed', formConfig[k] !== currentConfig[k]);
    });

    var doseMap = {
        'inp-base-pulse-ms': 'base_pulse_ms',
        'inp-pulse-per-unit': 'pulse_per_unit',
        'inp-max-pulse-ms': 'max_pulse_ms',
        'inp-session-duration-s': 'session_duration_s',
        'inp-warmup-s': 'warmup_s',
    };
    Object.keys(doseMap).forEach(function(id) {
        var k = doseMap[id];
        var el = document.getElementById(id);
        if (el) el.classList.toggle('field-changed', formDose[k] !== currentDose[k]);
    });

    var intEl = document.getElementById('inp-measure-interval-min');
    if (intEl) {
        var curMin = Math.round(currentDose.measure_interval_s / 60);
        var frmMin = Math.round(formDose.measure_interval_s / 60);
        intEl.classList.toggle('field-changed', curMin !== frmMin);
    }
}

// ================================================================
// SAFETY ALERTS
// ================================================================
function checkSafetyAlerts() {
    var alerts = [];

    var pOut = parseInt(getVal('inp-pump-out'));
    var pIn = parseInt(getVal('inp-pump-in'));
    if (!isNaN(pOut) && !isNaN(pIn) && pIn < pOut) {
        alerts.push('⚠ Thời gian bơm vào nên ≥ bơm ra để bù đủ nước');
    }
    var session = parseInt(getVal('inp-session-duration-s'));
    var iv = parseInt(getVal('inp-measure-interval-min')) * 60;
    if (!isNaN(session) && !isNaN(iv) && session > iv) {
        alerts.push('⚠ Thời gian phiên đo không được dài hơn chu kỳ đo');
    }

    var banner = document.getElementById('safety-alert-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'safety-alert-banner';
        banner.className = 'safety-alert-banner';
        document.querySelector('.settings-wrapper').prepend(banner);
    }
    banner.innerHTML = alerts.map(function(a) { return '<div>' + a + '</div>'; }).join('');
    banner.classList.toggle('visible', alerts.length > 0);
}

// ================================================================
// INPUT LISTENERS
// ================================================================
function attachInputListeners() {
    ['inp-temp-min', 'inp-temp-max', 'inp-ph-min', 'inp-ph-max',
        'inp-tds-target', 'inp-tds-tol'
    ].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', function() {
            syncFormConfig();
            updatePreviews();
            updateDirtyState();
            updateFieldHighlights();
            checkSafetyAlerts();
        });
    });

    ['inp-measure-interval-min', 'inp-session-duration-s', 'inp-warmup-s',
        'inp-base-pulse-ms', 'inp-pulse-per-unit', 'inp-max-pulse-ms'
    ].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', function() {
            syncFormDose();
            updateDosePreviews();
            updateDirtyState();
            updateFieldHighlights();
            checkSafetyAlerts();
        });
    });

    ['inp-hour', 'inp-minute', 'inp-pump-out', 'inp-pump-in'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', function() {
            syncFormSchedule();
            updateSchedulePreviews();
            updateDirtyState();
            updateFieldHighlights();
            checkSafetyAlerts();
        });
    });
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
    var inputs = document.getElementById('schedule-timing-inputs');
    inputs.style.opacity = enabled ? '1' : '0.3';
    inputs.style.pointerEvents = enabled ? 'auto' : 'none';
    document.getElementById('lbl-schedule').textContent =
        enabled ? 'Lịch tự động: Bật' : 'Lịch tự động: Tắt';
}

// ================================================================
// SAVE
// ================================================================
window.saveAll = function() {
    syncFormConfig();
    syncFormDose();
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
        })
        .then(function() {
            return updateRef('settings/ph_dose_config', {
                measure_interval_s: formDose.measure_interval_s,
                session_duration_s: formDose.session_duration_s,
                warmup_s: formDose.warmup_s,
                base_pulse_ms: formDose.base_pulse_ms,
                pulse_per_unit: formDose.pulse_per_unit,
                max_pulse_ms: formDose.max_pulse_ms,
            });
        })
        .then(function() {
            return updateRef('settings/water_schedule', {
                enabled: scheduleEnabled,
                hour: formSchedule.hour,
                minute: formSchedule.minute,
                pump_out_sec: formSchedule.pump_out_sec,
                pump_in_sec: formSchedule.pump_in_sec,
            });
        })
        .then(function() {
            currentConfig = Object.assign({}, formConfig);
            currentDose = Object.assign({}, formDose);
            currentSchedule = Object.assign({}, formSchedule, { enabled: scheduleEnabled });
            updateDirtyState();
            updateFieldHighlights();
            showToast('Đã lưu thành công ✓', 'success');
        })
        .catch(function(err) {
            console.error('Save error:', err);
            showToast('Lưu thất bại: ' + err.message, 'error');
        })
        .finally(function() {
            btn.textContent = 'Lưu';
            updateDirtyState();
        });
};

// ================================================================
// REVERT
// ================================================================
window.revertChanges = function() {
    formConfig = Object.assign({}, currentConfig);
    formDose = Object.assign({}, currentDose);
    formSchedule = Object.assign({}, currentSchedule);
    scheduleEnabled = !!currentSchedule.enabled;

    setVal('inp-temp-min', currentConfig.temp_min);
    setVal('inp-temp-max', currentConfig.temp_max);
    setVal('inp-ph-min', currentConfig.ph_min);
    setVal('inp-ph-max', currentConfig.ph_max);
    setVal('inp-tds-target', currentConfig.tds_target);
    setVal('inp-tds-tol', currentConfig.tds_tolerance);

    setVal('inp-measure-interval-min', Math.round(currentDose.measure_interval_s / 60));
    setVal('inp-session-duration-s', currentDose.session_duration_s);
    setVal('inp-warmup-s', currentDose.warmup_s);
    setVal('inp-base-pulse-ms', currentDose.base_pulse_ms);
    setVal('inp-pulse-per-unit', currentDose.pulse_per_unit);
    setVal('inp-max-pulse-ms', currentDose.max_pulse_ms);

    setVal('inp-hour', currentSchedule.hour);
    setVal('inp-minute', currentSchedule.minute);
    setVal('inp-pump-out', currentSchedule.pump_out_sec);
    setVal('inp-pump-in', currentSchedule.pump_in_sec);
    applyScheduleToggleUI(scheduleEnabled);

    updatePreviews();
    updateDosePreviews();
    updateSchedulePreviews();
    updateDirtyState();
    updateFieldHighlights();
    showToast('Đã hoàn tác về giá trị Firebase', 'success');
};

// ================================================================
// RESET TO DEFAULT
// ================================================================
window.resetToDefault = function() {
    if (!confirm('Khôi phục tất cả cài đặt về mặc định?')) return;
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
        })
        .then(function() { return updateRef('settings/ph_dose_config', Object.assign({}, DEFAULTS_DOSE)); })
        .then(function() { return updateRef('settings/water_schedule', Object.assign({}, DEFAULTS_SCHEDULE)); })
        .then(function() { showToast('Đã khôi phục mặc định ✓', 'success'); })
        .catch(function(err) { showToast('Khôi phục thất bại: ' + err.message, 'error'); })
        .finally(function() {
            btn.textContent = 'Lưu';
            updateDirtyState();
        });
};

// ================================================================
// TRIGGER WATER CHANGE
// ================================================================
window.triggerWaterChange = function() {
    if (wcState !== 'IDLE') return;
    updateRef('water_change/manual_trigger', true)
        .then(function() { showToast('Đã kích hoạt thay nước ✓', 'success'); })
        .catch(function(err) { showToast('Lỗi: ' + err.message, 'error'); });
};

// ================================================================
// UTILS
// ================================================================
function getVal(id) {
    var el = document.getElementById(id);
    return el ? el.value : '';
}

function setVal(id, v) {
    var el = document.getElementById(id);
    if (el && v !== undefined && v !== null) el.value = v;
}

function setErr(id, show) {
    var el = document.getElementById(id);
    if (el) el.style.display = show ? 'block' : 'none';
}

function setInputErr(id, show) {
    var el = document.getElementById(id);
    if (el) el.classList.toggle('input-error', show);
}

function pickEditableSchedule(schedule) {
    return {
        hour: schedule.hour,
        minute: schedule.minute,
        pump_out_sec: schedule.pump_out_sec,
        pump_in_sec: schedule.pump_in_sec,
    };
}

function fmtSec(s) {
    var m = Math.floor(s / 60),
        r = s % 60;
    return m > 0 ? m + ' phút ' + r + ' giây' : r + ' giây';
}

function fmtTimestampVN(ms) {
    return new Date(ms).toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function buildHourOptions() {
    var sel = document.getElementById('inp-hour');
    if (!sel) return;
    for (var h = 0; h < 24; h++) {
        var o = document.createElement('option');
        o.value = h;
        o.textContent = String(h).padStart(2, '0') + ':00';
        sel.appendChild(o);
    }
}

function buildMinuteOptions() {
    var sel = document.getElementById('inp-minute');
    if (!sel) return;
    for (var m = 0; m < 60; m++) {
        var o = document.createElement('option');
        o.value = m;
        o.textContent = String(m).padStart(2, '0');
        sel.appendChild(o);
    }
}

function showToast(msg, type) {
    type = type || 'info';
    var c = document.getElementById('toast-container');
    if (!c) return;
    var t = document.createElement('div');
    t.className = 'toast toast-' + type;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(function() { t.classList.add('show'); }, 10);
    setTimeout(function() {
        t.classList.remove('show');
        setTimeout(function() { t.remove(); }, 300);
    }, 3000);
}
