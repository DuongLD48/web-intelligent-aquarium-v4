// ================================================================
// history-service.js — Intelligent Aquarium v7.3
// Đọc lịch sử trực tiếp từ RTDB: devices/aquarium_1/history/{ts}
// Format mỗi node: { ph, tds, temp }
// Tự động xóa node cũ hơn 12h.
// ================================================================

import { db, DEVICE_ID } from './firebase-init.js';
import {
    ref,
    get,
    remove,
    query,
    orderByKey,
    startAt,
    endAt,
    onChildAdded,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ── Cấu hình ────────────────────────────────────────────────────
const WINDOW_S = 12 * 60 * 60; // 12 giờ tính bằng giây (RTDB key là Unix giây)
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // dọn dữ liệu mỗi 30 phút (ms)

const HISTORY_PATH = () => `devices/${DEVICE_ID}/history/chart`;

const _listeners = [];
let _unsubscribe = null;
let _lastCleanup = 0;
let _lastSeenTs = 0; // timestamp lớn nhất đã thấy

// ── Public API ───────────────────────────────────────────────────

/**
 * Đọc toàn bộ lịch sử 12h gần nhất từ RTDB một lần.
 * Trả về { temp: [{ts, v}], ph: [{ts, v}], tds: [{ts, v}] }
 */
export async function fetchHistory() {
    const sinceS = Math.floor(Date.now() / 1000) - WINDOW_S;
    const since = String(sinceS); // RTDB key là 10 chữ số, không cần pad
    console.log('[history] fetchHistory from', new Date(sinceS * 1000).toLocaleTimeString());

    try {
        const q = query(
            ref(db, HISTORY_PATH()),
            orderByKey(),
            startAt(since),
        );
        const snap = await get(q);

        const result = { temp: [], ph: [], tds: [] };
        if (!snap.exists()) {
            console.log('[history] no data found');
            return result;
        }

        snap.forEach(child => {
            const tsS = parseInt(child.key); // key là Unix giây
            const tsMs = tsS * 1000; // đổi sang ms cho chart
            const val = child.val();
            if (val.temp !== undefined) result.temp.push({ ts: tsMs, v: parseFloat(val.temp) });
            if (val.ph !== undefined) result.ph.push({ ts: tsMs, v: parseFloat(val.ph) });
            if (val.tds !== undefined) result.tds.push({ ts: tsMs, v: parseFloat(val.tds) });
            if (tsS > _lastSeenTs) _lastSeenTs = tsS;
        });

        console.log(`[history] loaded: temp=${result.temp.length} ph=${result.ph.length} tds=${result.tds.length}`);
        return result;

    } catch (e) {
        console.error('[history] fetchHistory ERROR:', e.message);
        return { temp: [], ph: [], tds: [] };
    }
}

/**
 * Lắng nghe realtime các node mới được thêm vào RTDB.
 * Chỉ notify điểm mới hơn _lastSeenTs (tránh replay lịch sử).
 * Gọi sau fetchHistory() để _lastSeenTs đã được set.
 * @returns unsubscribe function
 */
export function startPolling() {
    if (_unsubscribe) _unsubscribe();

    const sinceS = _lastSeenTs > 0 ? _lastSeenTs : Math.floor(Date.now() / 1000) - WINDOW_S;
    const since = String(sinceS); // RTDB key là 10 chữ số, không cần pad

    const q = query(
        ref(db, HISTORY_PATH()),
        orderByKey(),
        startAt(since),
    );

    // onChildAdded fires cho mỗi node hiện có + node mới realtime
    // Ta dùng _lastSeenTs để bỏ qua node cũ đã load qua fetchHistory
    const unsub = onChildAdded(q, (child) => {
        const tsS = parseInt(child.key); // key là Unix giây
        const tsMs = tsS * 1000; // đổi sang ms cho chart
        const val = child.val();

        // Bỏ qua node đã thấy trong fetchHistory
        if (tsS <= _lastSeenTs && _lastSeenTs > 0) return;

        _lastSeenTs = tsS;

        if (val.temp !== undefined) _notifyListeners('temp', parseFloat(val.temp), tsMs);
        if (val.ph !== undefined) _notifyListeners('ph', parseFloat(val.ph), tsMs);
        if (val.tds !== undefined) _notifyListeners('tds', parseFloat(val.tds), tsMs);

        // Cleanup định kỳ mỗi 30 phút
        const now = Date.now();
        if (now - _lastCleanup >= CLEANUP_INTERVAL_MS) {
            _lastCleanup = now;
            _cleanupOldNodes().catch(e => console.warn('[history] cleanup error:', e));
        }
    });

    _unsubscribe = unsub;
    console.log('[history] realtime listener started from', new Date(sinceS * 1000).toLocaleTimeString());

    // Chạy cleanup ngay lập tức (không chờ node mới)
    _lastCleanup = Date.now();
    _cleanupOldNodes().catch(e => console.warn('[history] cleanup init error:', e));

    return () => {
        if (_unsubscribe) {
            _unsubscribe();
            _unsubscribe = null;
        }
    };
}

/**
 * Đăng ký callback nhận điểm dữ liệu mới.
 * @param {function} fn - nhận { sensor, value, ts }
 */
export function onNewPoint(fn) {
    _listeners.push(fn);
}

// ── Xóa node cũ hơn 12h ─────────────────────────────────────────

async function _cleanupOldNodes() {
    const cutoffS = Math.floor(Date.now() / 1000) - WINDOW_S;
    const cutoffStr = String(cutoffS); // RTDB key 10 chữ số, string sort = number sort, KHÔNG pad
    console.log('[history] cleanup: xóa node trước', new Date(cutoffS * 1000).toLocaleTimeString());

    try {
        const q = query(
            ref(db, HISTORY_PATH()),
            orderByKey(),
            endAt(cutoffStr),
        );
        const snap = await get(q);
        if (!snap.exists()) {
            console.log('[history] cleanup: không có node cũ');
            return;
        }

        // Dùng child.key để tạo ref chính xác (child.ref không khả dụng với get())
        const removes = [];
        snap.forEach(child => {
            const nodeRef = ref(db, `${HISTORY_PATH()}/${child.key}`);
            removes.push(remove(nodeRef));
        });
        await Promise.all(removes);
        console.log(`[history] cleanup: đã xóa ${removes.length} node cũ`);
    } catch (e) {
        console.warn('[history] cleanup error:', e.message);
    }
}

// ── Debug ────────────────────────────────────────────────────────
window._historyDebug = {
    status() {
        console.log('[debug] lastSeenTs:', _lastSeenTs ? new Date(_lastSeenTs).toLocaleString() : 'none');
        console.log('[debug] listeners:', _listeners.length);
        console.log('[debug] realtime:', _unsubscribe ? 'ON' : 'OFF');
    },
    async testRead() {
        const data = await fetchHistory();
        for (const [k, arr] of Object.entries(data)) {
            console.log(`[debug] ${k}: ${arr.length} pts | latest:`, arr.at(-1));
        }
    },
    async forceCleanup() {
        await _cleanupOldNodes();
        console.log('[debug] forceCleanup done');
    },
};

console.log('[history] ✅ module loaded (RTDB) | debug: window._historyDebug.status()');

// ── Internal ─────────────────────────────────────────────────────
function _notifyListeners(sensor, value, ts) {
    _listeners.forEach(fn => {
        try { fn({ sensor, value, ts }); } catch (e) {
            console.warn('[history] listener error:', e);
        }
    });
}