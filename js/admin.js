// ================================================================
// admin.js — Intelligent Aquarium v7.1
// Admin config: pipeline + safety thresholds
// ================================================================

import { listenRef, updateRef, onConnectionChange, requireAuth, doLogout } from './firebase-init.js';

// ================================================================
// DEFAULTS
// ================================================================
const DEFAULTS_PIPELINE = {
    temp_range_min: 15.0,
    temp_range_max: 40.0,
    ph_range_min: 4.0,
    ph_range_max: 10.0,
    tds_range_min: 1.0,
    tds_range_max: 3000.0,
    mad_window_size: 30,
    mad_min_samples: 10,
    mad_threshold: 3.5,
    mad_floor_temp: 0.30,
    mad_floor_ph: 0.08,
    mad_floor_tds: 3.0,
    shock_temp_delta: 3.0,
    shock_ph_delta: 0.5,
};

const DEFAULTS_SAFETY = {
    thermal_cutoff_c: 42.0,
    temp_emergency_cool_c: 38.0,
    heater_max_runtime_ms: 600000,
    heater_cooldown_ms: 300000,
    ph_pump_max_pulse_ms: 3000,
    ph_pump_min_interval_ms: 30000,
    stale_sensor_threshold: 6,
};

const DEFAULTS_ANALYTICS = {
    ema_alpha: 0.1,
    cusum_k: 0.5,
    cusum_threshold: 5.0,
    wsi_weight_temp: 0.4,
    wsi_weight_ph: 0.4,
    wsi_weight_tds: 0.2,
    fsi_alpha: 0.5,
    fsi_beta: 0.3,
    fsi_shock_penalty: 20.0,
};
const DEFAULTS_WATER_SCHEDULE = {
    pump_min_sec: 10,
    pump_out_max_sec: 300,
    pump_in_max_sec: 600,
};

// ================================================================
const SAFE_RANGES = {
    temp_range_min: { min: 0, max: 30, label: 'Temp Range Min' },
    temp_range_max: { min: 25, max: 60, label: 'Temp Range Max' },
    ph_range_min: { min: 0, max: 6, label: 'pH Range Min' },
    ph_range_max: { min: 8, max: 14, label: 'pH Range Max' },
    tds_range_min: { min: 0, max: 100, label: 'TDS Range Min' },
    tds_range_max: { min: 500, max: 10000, label: 'TDS Range Max' },
    mad_window_size: { min: 5, max: 200, label: 'MAD Window' },
    mad_min_samples: { min: 3, max: 100, label: 'MAD Min Samples' },
    mad_threshold: { min: 1.0, max: 10.0, label: 'MAD Threshold' },
    thermal_cutoff_c: { min: 35, max: 55, label: 'Thermal Cutoff' },
    temp_emergency_cool_c: { min: 30, max: 45, label: 'Emergency Cool' },
    heater_max_runtime_ms: { min: 60000, max: 3600000, label: 'Heater Max Runtime' },
    heater_cooldown_ms: { min: 30000, max: 1800000, label: 'Heater Cooldown' },
    ph_pump_max_pulse_ms: { min: 100, max: 10000, label: 'pH Max Pulse' },
    ph_pump_min_interval_ms: { min: 5000, max: 300000, label: 'pH Min Interval' },
    stale_sensor_threshold: { min: 1, max: 60, label: 'Stale Threshold' },
    pump_min_sec: { min: 1, max: 60, label: 'Pump Min' },
    pump_out_max_sec: { min: 10, max: 3600, label: 'Pump Out Max' },
    pump_in_max_sec: { min: 10, max: 7200, label: 'Pump In Max' },
};

// ================================================================
// STATE
// ================================================================
let currentPipeline = {};
let currentSafety = {};
let currentAnalytics = {};
let currentWaterSchedule = {};
let formPipeline = {};
let formSafety = {};
let formAnalytics = {};
let formWaterSchedule = {};

// ================================================================
// FIELD → STATE MAP
// ================================================================
const FIELD_MAP = {
    'inp-temp-range-min': ['pipeline', 'temp_range_min'],
    'inp-temp-range-max': ['pipeline', 'temp_range_max'],
    'inp-ph-range-min': ['pipeline', 'ph_range_min'],
    'inp-ph-range-max': ['pipeline', 'ph_range_max'],
    'inp-tds-range-min': ['pipeline', 'tds_range_min'],
    'inp-tds-range-max': ['pipeline', 'tds_range_max'],
    'inp-mad-window': ['pipeline', 'mad_window_size'],
    'inp-mad-min-samples': ['pipeline', 'mad_min_samples'],
    'inp-mad-threshold': ['pipeline', 'mad_threshold'],
    'inp-mad-floor-temp': ['pipeline', 'mad_floor_temp'],
    'inp-mad-floor-ph': ['pipeline', 'mad_floor_ph'],
    'inp-mad-floor-tds': ['pipeline', 'mad_floor_tds'],
    'inp-shock-temp': ['pipeline', 'shock_temp_delta'],
    'inp-shock-ph': ['pipeline', 'shock_ph_delta'],
    'inp-thermal-cutoff': ['safety', 'thermal_cutoff_c'],
    'inp-emergency-cool': ['safety', 'temp_emergency_cool_c'],
    'inp-heater-max-runtime': ['safety', 'heater_max_runtime_ms'],
    'inp-heater-cooldown': ['safety', 'heater_cooldown_ms'],
    'inp-ph-max-pulse': ['safety', 'ph_pump_max_pulse_ms'],
    'inp-ph-min-interval': ['safety', 'ph_pump_min_interval_ms'],
    'inp-stale-threshold': ['safety', 'stale_sensor_threshold'],
    'inp-ac-ema-alpha': ['analytics', 'ema_alpha'],
    'inp-ac-cusum-k': ['analytics', 'cusum_k'],
    'inp-ac-cusum-threshold': ['analytics', 'cusum_threshold'],
    'inp-ac-wsi-weight-temp': ['analytics', 'wsi_weight_temp'],
    'inp-ac-wsi-weight-ph': ['analytics', 'wsi_weight_ph'],
    'inp-ac-wsi-weight-tds': ['analytics', 'wsi_weight_tds'],
    'inp-ac-fsi-alpha': ['analytics', 'fsi_alpha'],
    'inp-ac-fsi-beta': ['analytics', 'fsi_beta'],
    'inp-ac-fsi-shock-penalty': ['analytics', 'fsi_shock_penalty'],
    'inp-pump-min-sec': ['waterSchedule', 'pump_min_sec'],
    'inp-pump-out-max-sec': ['waterSchedule', 'pump_out_max_sec'],
    'inp-pump-in-max-sec': ['waterSchedule', 'pump_in_max_sec'],
};

// ================================================================
// INIT
// ================================================================
(async function init() {
    await requireAuth();
    attachInputListeners();
    attachResetConfirmListener();

    listenRef('settings/pipeline_config', onPipelineSnap);
    listenRef('settings/safety_limits', onSafetySnap);
    listenRef('settings/analytics_config', onAnalyticsSnap);
    listenRef('settings/water_schedule', onWaterScheduleSnap);
    listenRef('status', function(snap) {
        if (!snap.exists()) return;
        document.getElementById('dot-online').className = 'status-dot online';
        document.getElementById('txt-online').textContent = 'Online';
    });

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
function onPipelineSnap(snap) {
    var d = snap.exists() ? snap.val() : {};
    currentPipeline = Object.assign({}, DEFAULTS_PIPELINE, d);
    formPipeline = Object.assign({}, currentPipeline);
    populatePipelineFields();
    updateDirtyState();
    updateFieldHighlights();
    checkSafetyAlerts();
}

function onSafetySnap(snap) {
    var d = snap.exists() ? snap.val() : {};
    currentSafety = Object.assign({}, DEFAULTS_SAFETY, d);
    formSafety = Object.assign({}, currentSafety);
    populateSafetyFields();
    updateDirtyState();
    updateFieldHighlights();
    checkSafetyAlerts();
}

function onAnalyticsSnap(snap) {
    var d = snap.exists() ? snap.val() : {};
    currentAnalytics = Object.assign({}, DEFAULTS_ANALYTICS, d);
    formAnalytics = Object.assign({}, currentAnalytics);
    populateAnalyticsFields();
    updateDirtyState();
    updateFieldHighlights();
    checkSafetyAlerts();
}

function onWaterScheduleSnap(snap) {
    var d = snap.exists() ? snap.val() : {};
    currentWaterSchedule = Object.assign({}, DEFAULTS_WATER_SCHEDULE, d);
    formWaterSchedule = Object.assign({}, currentWaterSchedule);
    populateWaterScheduleFields();
    updateDirtyState();
    updateFieldHighlights();
    checkSafetyAlerts();
}

// ================================================================
// POPULATE FIELDS
// ================================================================
function populatePipelineFields() {
    setVal('inp-temp-range-min', currentPipeline.temp_range_min);
    setVal('inp-temp-range-max', currentPipeline.temp_range_max);
    setVal('inp-ph-range-min', currentPipeline.ph_range_min);
    setVal('inp-ph-range-max', currentPipeline.ph_range_max);
    setVal('inp-tds-range-min', currentPipeline.tds_range_min);
    setVal('inp-tds-range-max', currentPipeline.tds_range_max);
    setVal('inp-mad-window', currentPipeline.mad_window_size);
    setVal('inp-mad-min-samples', currentPipeline.mad_min_samples);
    setVal('inp-mad-threshold', currentPipeline.mad_threshold);
    setVal('inp-mad-floor-temp', currentPipeline.mad_floor_temp);
    setVal('inp-mad-floor-ph', currentPipeline.mad_floor_ph);
    setVal('inp-mad-floor-tds', currentPipeline.mad_floor_tds);
    setVal('inp-shock-temp', currentPipeline.shock_temp_delta);
    setVal('inp-shock-ph', currentPipeline.shock_ph_delta);
    setVal('inp-ema-alpha', currentPipeline.ema_alpha);
    setVal('inp-cusum-k', currentPipeline.cusum_k);
    setVal('inp-cusum-threshold', currentPipeline.cusum_threshold);
}

function populateSafetyFields() {
    setVal('inp-thermal-cutoff', currentSafety.thermal_cutoff_c);
    setVal('inp-emergency-cool', currentSafety.temp_emergency_cool_c);
    setVal('inp-heater-max-runtime', currentSafety.heater_max_runtime_ms);
    setVal('inp-heater-cooldown', currentSafety.heater_cooldown_ms);
    setVal('inp-ph-max-pulse', currentSafety.ph_pump_max_pulse_ms);
    setVal('inp-ph-min-interval', currentSafety.ph_pump_min_interval_ms);
    setVal('inp-stale-threshold', currentSafety.stale_sensor_threshold);
    updateMsHints();
}

function populateWaterScheduleFields() {
    setVal('inp-pump-min-sec', currentWaterSchedule.pump_min_sec);
    setVal('inp-pump-out-max-sec', currentWaterSchedule.pump_out_max_sec);
    setVal('inp-pump-in-max-sec', currentWaterSchedule.pump_in_max_sec);
    updatePumpSecHints();
}

function populateAnalyticsFields() {
    setVal('inp-ac-ema-alpha', currentAnalytics.ema_alpha);
    setVal('inp-ac-cusum-k', currentAnalytics.cusum_k);
    setVal('inp-ac-cusum-threshold', currentAnalytics.cusum_threshold);
    setVal('inp-ac-wsi-weight-temp', currentAnalytics.wsi_weight_temp);
    setVal('inp-ac-wsi-weight-ph', currentAnalytics.wsi_weight_ph);
    setVal('inp-ac-wsi-weight-tds', currentAnalytics.wsi_weight_tds);
    setVal('inp-ac-fsi-alpha', currentAnalytics.fsi_alpha);
    setVal('inp-ac-fsi-beta', currentAnalytics.fsi_beta);
    setVal('inp-ac-fsi-shock-penalty', currentAnalytics.fsi_shock_penalty);
}

// ================================================================
// MS → HUMAN READABLE HINTS
// ================================================================
function fmtMs(ms) {
    var n = parseInt(ms) || 0;
    if (n >= 3600000) return (n / 3600000).toFixed(1) + ' giờ';
    if (n >= 60000) return (n / 60000).toFixed(1) + ' phút';
    return n + ' ms';
}

function fmtSec(s) {
    var n = parseInt(s) || 0;
    if (n >= 3600) return (n / 3600).toFixed(1) + ' giờ';
    if (n >= 60) return (n / 60).toFixed(1) + ' phút';
    return n + ' giây';
}

function updatePumpSecHints() {
    var fields = [
        ['inp-pump-out-max-sec', 'hint-pump-out-max'],
        ['inp-pump-in-max-sec', 'hint-pump-in-max'],
    ];
    fields.forEach(function(pair) {
        var val = getVal(pair[0]);
        var el = document.getElementById(pair[1]);
        if (el) el.textContent = val ? '= ' + fmtSec(val) : '';
    });
}

function updateMsHints() {
    var fields = [
        ['inp-heater-max-runtime', 'hint-heater-runtime'],
        ['inp-heater-cooldown', 'hint-heater-cooldown'],
        ['inp-ph-max-pulse', 'hint-ph-pulse'],
        ['inp-ph-min-interval', 'hint-ph-interval'],
    ];
    fields.forEach(function(pair) {
        var val = getVal(pair[0]);
        var el = document.getElementById(pair[1]);
        if (el) el.textContent = val ? '= ' + fmtMs(val) : '';
    });
}

// ================================================================
// SYNC FORM STATE
// ================================================================
function syncForm() {
    // Pipeline
    formPipeline.temp_range_min = parseFloat(getVal('inp-temp-range-min'));
    formPipeline.temp_range_max = parseFloat(getVal('inp-temp-range-max'));
    formPipeline.ph_range_min = parseFloat(getVal('inp-ph-range-min'));
    formPipeline.ph_range_max = parseFloat(getVal('inp-ph-range-max'));
    formPipeline.tds_range_min = parseFloat(getVal('inp-tds-range-min'));
    formPipeline.tds_range_max = parseFloat(getVal('inp-tds-range-max'));
    formPipeline.mad_window_size = parseInt(getVal('inp-mad-window'));
    formPipeline.mad_min_samples = parseInt(getVal('inp-mad-min-samples'));
    formPipeline.mad_threshold = parseFloat(getVal('inp-mad-threshold'));
    formPipeline.mad_floor_temp = parseFloat(getVal('inp-mad-floor-temp'));
    formPipeline.mad_floor_ph = parseFloat(getVal('inp-mad-floor-ph'));
    formPipeline.mad_floor_tds = parseFloat(getVal('inp-mad-floor-tds'));
    formPipeline.shock_temp_delta = parseFloat(getVal('inp-shock-temp'));
    formPipeline.shock_ph_delta = parseFloat(getVal('inp-shock-ph'));

    // Safety
    formSafety.thermal_cutoff_c = parseFloat(getVal('inp-thermal-cutoff'));
    formSafety.temp_emergency_cool_c = parseFloat(getVal('inp-emergency-cool'));
    formSafety.heater_max_runtime_ms = parseInt(getVal('inp-heater-max-runtime'));
    formSafety.heater_cooldown_ms = parseInt(getVal('inp-heater-cooldown'));
    formSafety.ph_pump_max_pulse_ms = parseInt(getVal('inp-ph-max-pulse'));
    formSafety.ph_pump_min_interval_ms = parseInt(getVal('inp-ph-min-interval'));
    // Analytics
    formAnalytics.ema_alpha = parseFloat(getVal('inp-ac-ema-alpha'));
    formAnalytics.cusum_k = parseFloat(getVal('inp-ac-cusum-k'));
    formAnalytics.cusum_threshold = parseFloat(getVal('inp-ac-cusum-threshold'));
    formAnalytics.wsi_weight_temp = parseFloat(getVal('inp-ac-wsi-weight-temp'));
    formAnalytics.wsi_weight_ph = parseFloat(getVal('inp-ac-wsi-weight-ph'));
    formAnalytics.wsi_weight_tds = parseFloat(getVal('inp-ac-wsi-weight-tds'));
    formAnalytics.fsi_alpha = parseFloat(getVal('inp-ac-fsi-alpha'));
    formAnalytics.fsi_beta = parseFloat(getVal('inp-ac-fsi-beta'));
    formAnalytics.fsi_shock_penalty = parseFloat(getVal('inp-ac-fsi-shock-penalty'));

    // Water Schedule
    formWaterSchedule.pump_min_sec = parseInt(getVal('inp-pump-min-sec'));
    formWaterSchedule.pump_out_max_sec = parseInt(getVal('inp-pump-out-max-sec'));
    formWaterSchedule.pump_in_max_sec = parseInt(getVal('inp-pump-in-max-sec'));
}

// ================================================================
// INPUT LISTENERS
// ================================================================
function attachInputListeners() {
    Object.keys(FIELD_MAP).forEach(function(id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', function() {
            syncForm();
            updateMsHints();
            updatePumpSecHints();
            updateDirtyState();
            updateFieldHighlights();
            checkSafetyAlerts();
        });
    });
    // WSI weight preview updates on input (already covered above, but ensure prev-wsi-weights live)
    ['inp-ac-wsi-weight-temp', 'inp-ac-wsi-weight-ph', 'inp-ac-wsi-weight-tds'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', checkSafetyAlerts);
    });
}

// ================================================================
// FIELD HIGHLIGHTS (yellow = changed, not yet saved)
// ================================================================
function updateFieldHighlights() {
    Object.entries(FIELD_MAP).forEach(function(entry) {
        var id = entry[0];
        var src = entry[1][0];
        var key = entry[1][1];
        var el = document.getElementById(id);
        if (!el) return;
        var current = src === 'pipeline' ? currentPipeline : src === 'analytics' ? currentAnalytics : src === 'waterSchedule' ? currentWaterSchedule : currentSafety;
        var form = src === 'pipeline' ? formPipeline : src === 'analytics' ? formAnalytics : src === 'waterSchedule' ? formWaterSchedule : formSafety;
        el.classList.toggle('field-changed',
            form[key] !== undefined && form[key] !== current[key]);
    });
}

// ================================================================
// SAFETY ALERT BANNER
// ================================================================
function checkSafetyAlerts() {
    var alerts = [];

    // Thermal: cutoff must be > emergency cool
    var cutoff = parseFloat(getVal('inp-thermal-cutoff'));
    var eCool = parseFloat(getVal('inp-emergency-cool'));
    var thermalOk = !isNaN(cutoff) && !isNaN(eCool) && cutoff > eCool;
    var errEl = document.getElementById('err-thermal');
    if (errEl) errEl.style.display = thermalOk ? 'none' : 'block';
    if (!thermalOk && !isNaN(cutoff) && !isNaN(eCool)) {
        alerts.push('⚠ Thermal Cutoff phải lớn hơn Emergency Cool');
        document.getElementById('inp-thermal-cutoff').classList.add('field-danger');
        document.getElementById('inp-emergency-cool').classList.add('field-danger');
    } else {
        ['inp-thermal-cutoff', 'inp-emergency-cool'].forEach(function(id) {
            var _e = document.getElementById(id);
            if (_e) _e.classList.remove('field-danger');
        });
    }

    // MAD: min_samples must be <= window_size
    var win = parseInt(getVal('inp-mad-window'));
    var minS = parseInt(getVal('inp-mad-min-samples'));
    if (!isNaN(win) && !isNaN(minS) && minS > win) {
        alerts.push('⚠ MAD Min Samples (' + minS + ') không được lớn hơn Window Size (' + win + ')');
        document.getElementById('inp-mad-min-samples').classList.add('field-danger');
    } else {
        var _ms = document.getElementById('inp-mad-min-samples');
        if (_ms) _ms.classList.remove('field-danger');
    }

    // WSI weights must sum to 1.0
    var wt = parseFloat(getVal('inp-ac-wsi-weight-temp')) || 0;
    var wp = parseFloat(getVal('inp-ac-wsi-weight-ph')) || 0;
    var wd = parseFloat(getVal('inp-ac-wsi-weight-tds')) || 0;
    var wsum = Math.round((wt + wp + wd) * 1000) / 1000;
    var wsiEl = document.getElementById('prev-wsi-weights');
    if (wsiEl) {
        wsiEl.textContent = '→ Tổng: ' + wsum.toFixed(3);
        wsiEl.style.color = Math.abs(wsum - 1.0) < 0.001 ? 'var(--accent-ok)' : 'var(--accent-err)';
    }
    if (Math.abs(wsum - 1.0) >= 0.001) {
        alerts.push('⚠ Tổng WSI weights = ' + wsum.toFixed(3) + ' — phải bằng 1.000');
    }

    // Analytics EMA alpha
    var acAlpha = parseFloat(getVal('inp-ac-ema-alpha'));
    if (!isNaN(acAlpha) && (acAlpha <= 0 || acAlpha > 0.5)) {
        alerts.push('⚠ Analytics EMA Alpha phải trong khoảng (0, 0.5]');
        var _aa = document.getElementById('inp-ac-ema-alpha');
        if (_aa) _aa.classList.add('field-danger');
    } else {
        var _aa2 = document.getElementById('inp-ac-ema-alpha');
        if (_aa2) _aa2.classList.remove('field-danger');
    }
    if (!isNaN(alpha) && (alpha <= 0 || alpha > 1)) {
        alerts.push('⚠ EMA Alpha phải trong khoảng (0, 1]');
        document.getElementById('inp-ema-alpha').classList.add('field-danger');
    } else {
        var _ea = document.getElementById('inp-ema-alpha');
        if (_ea) _ea.classList.remove('field-danger');
    }

    // SAFE_RANGES checks
    [
        ['thermal_cutoff_c', parseFloat(getVal('inp-thermal-cutoff'))],
        ['temp_emergency_cool_c', parseFloat(getVal('inp-emergency-cool'))],
        ['heater_max_runtime_ms', parseInt(getVal('inp-heater-max-runtime'))],
        ['heater_cooldown_ms', parseInt(getVal('inp-heater-cooldown'))],
        ['ph_pump_max_pulse_ms', parseInt(getVal('inp-ph-max-pulse'))],
        ['ph_pump_min_interval_ms', parseInt(getVal('inp-ph-min-interval'))],
        ['stale_sensor_threshold', parseInt(getVal('inp-stale-threshold'))],
        ['mad_window_size', parseInt(getVal('inp-mad-window'))],
        ['mad_threshold', parseFloat(getVal('inp-mad-threshold'))],
    ].forEach(function(pair) {
        var key = pair[0];
        var val = pair[1];
        var r = SAFE_RANGES[key];
        if (!r || isNaN(val)) return;
        if (val < r.min || val > r.max) {
            alerts.push('⚠ ' + r.label + ': ' + val + ' — ngoài vùng khuyến nghị (' + r.min + '–' + r.max + ')');
        }
    });

    var banner = document.getElementById('safety-alert-banner');
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
// DIRTY STATE
// ================================================================
function isDirty() {
    return JSON.stringify(formPipeline) !== JSON.stringify(currentPipeline) ||
        JSON.stringify(formSafety) !== JSON.stringify(currentSafety) ||
        JSON.stringify(formAnalytics) !== JSON.stringify(currentAnalytics) ||
        JSON.stringify(formWaterSchedule) !== JSON.stringify(currentWaterSchedule);
}

function countDirtyFields() {
    var n = 0;
    Object.keys(currentPipeline).forEach(function(k) {
        if (formPipeline[k] !== currentPipeline[k]) n++;
    });
    Object.keys(currentSafety).forEach(function(k) {
        if (formSafety[k] !== currentSafety[k]) n++;
    });
    Object.keys(currentAnalytics).forEach(function(k) {
        if (formAnalytics[k] !== currentAnalytics[k]) n++;
    });
    Object.keys(currentWaterSchedule).forEach(function(k) {
        if (formWaterSchedule[k] !== currentWaterSchedule[k]) n++;
    });
    return n;
}

function updateDirtyState() {
    var dirty = isDirty();
    document.getElementById('dirty-indicator').classList.toggle('hidden', !dirty);
    if (dirty) document.getElementById('dirty-count').textContent = countDirtyFields();
    document.getElementById('btn-save').disabled = !dirty;
}

// ================================================================
// SAVE
// ================================================================
window.saveAll = function() {
    syncForm();

    // Block save if thermal constraint violated
    var cutoff = formSafety.thermal_cutoff_c;
    var eCool = formSafety.temp_emergency_cool_c;
    if (!isNaN(cutoff) && !isNaN(eCool) && cutoff <= eCool) {
        showToast('Thermal Cutoff phải > Emergency Cool', 'error');
        return;
    }

    var acAlpha = formAnalytics.ema_alpha;
    if (isNaN(acAlpha) || acAlpha <= 0 || acAlpha > 0.5) {
        showToast('Analytics EMA Alpha không hợp lệ (0 < α ≤ 0.5)', 'error');
        return;
    }
    var wsiSum = Math.round(((formAnalytics.wsi_weight_temp || 0) +
        (formAnalytics.wsi_weight_ph || 0) +
        (formAnalytics.wsi_weight_tds || 0)) * 1000) / 1000;
    if (Math.abs(wsiSum - 1.0) >= 0.001) {
        showToast('Tổng WSI weights = ' + wsiSum.toFixed(3) + ' — phải bằng 1.000', 'error');
        return;
    }

    var banner = document.getElementById('safety-alert-banner');
    if (banner && banner.classList.contains('visible')) {
        if (!confirm('⚠ Một số giá trị nằm ngoài vùng khuyến nghị. Vẫn muốn lưu?')) return;
    }

    var btn = document.getElementById('btn-save');
    btn.disabled = true;
    btn.textContent = 'Đang lưu...';

    updateRef('settings/pipeline_config', formPipeline)
        .then(function() {
            return updateRef('settings/safety_limits', formSafety);
        })
        .then(function() {
            return updateRef('settings/analytics_config', formAnalytics);
        })
        .then(function() {
            return updateRef('settings/water_schedule', formWaterSchedule);
        })
        .then(function() {
            currentPipeline = Object.assign({}, formPipeline);
            currentSafety = Object.assign({}, formSafety);
            currentAnalytics = Object.assign({}, formAnalytics);
            currentWaterSchedule = Object.assign({}, formWaterSchedule);
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
    formPipeline = Object.assign({}, currentPipeline);
    formSafety = Object.assign({}, currentSafety);
    formAnalytics = Object.assign({}, currentAnalytics);
    formWaterSchedule = Object.assign({}, currentWaterSchedule);
    populatePipelineFields();
    populateSafetyFields();
    populateAnalyticsFields();
    populateWaterScheduleFields();
    updateDirtyState();
    updateFieldHighlights();
    checkSafetyAlerts();
    showToast('Đã hoàn tác về giá trị Firebase', 'success');
};

// ================================================================
// RESET TO DEFAULTS
// ================================================================
window.showResetConfirm = function() {
    document.getElementById('inp-reset-confirm').value = '';
    document.getElementById('btn-confirm-reset').disabled = true;
    document.getElementById('reset-confirm-overlay').classList.add('visible');
};

window.hideResetConfirm = function() {
    document.getElementById('reset-confirm-overlay').classList.remove('visible');
};

function attachResetConfirmListener() {
    var inp = document.getElementById('inp-reset-confirm');
    if (!inp) return;
    inp.addEventListener('input', function() {
        document.getElementById('btn-confirm-reset').disabled =
            inp.value.trim() !== 'RESET';
    });
}

window.confirmReset = function() {
    hideResetConfirm();
    var btn = document.getElementById('btn-save');
    btn.disabled = true;
    btn.textContent = 'Đang khôi phục...';

    updateRef('settings/pipeline_config', DEFAULTS_PIPELINE)
        .then(function() {
            return updateRef('settings/safety_limits', DEFAULTS_SAFETY);
        })
        .then(function() {
            return updateRef('settings/analytics_config', DEFAULTS_ANALYTICS);
        })
        .then(function() {
            return updateRef('settings/water_schedule', DEFAULTS_WATER_SCHEDULE);
        })
        .then(function() {
            showToast('Đã khôi phục mặc định Admin ✓', 'success');
        })
        .catch(function(err) {
            showToast('Khôi phục thất bại: ' + err.message, 'error');
        })
        .finally(function() {
            btn.textContent = 'Lưu';
            updateDirtyState();
        });
};

// ================================================================
// TOAST
// ================================================================
function showToast(msg, type) {
    type = type || 'success';
    var toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = msg;
    document.getElementById('toast-container').appendChild(toast);
    setTimeout(function() { toast.remove(); }, 3200);
}

// ================================================================
// DOM HELPERS
// ================================================================
function getVal(id) {
    var el = document.getElementById(id);
    return el ? el.value : '';
}

function setVal(id, val) {
    var el = document.getElementById(id);
    if (el && val !== undefined && val !== null) el.value = val;
}