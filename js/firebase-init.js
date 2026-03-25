// ================================================================
// firebase-init.js — Intelligent Aquarium v7.0
// ================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
    getAuth,
    onAuthStateChanged,
    signOut,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
    getDatabase,
    ref,
    onValue,
    set,
    update,
    push,
    get,
    goOnline,
    goOffline,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ----------------------------------------------------------------
// Config
// ----------------------------------------------------------------
const firebaseConfig = {
    apiKey: "AIzaSyBYG_spuhL7dE5qWxXOFoUItJQqtlLJP50",
    authDomain: "intelligent-aquarium-4d05e.firebaseapp.com",
    databaseURL: "https://intelligent-aquarium-4d05e-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "intelligent-aquarium-4d05e",
    storageBucket: "intelligent-aquarium-4d05e.firebasestorage.app",
    messagingSenderId: "1046247363217",
    appId: "1:1046247363217:web:9603f01e61b877fb932530",
};

export const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

const DEVICE_ID = "aquarium_1";

// ----------------------------------------------------------------
// Connection monitor — tự động reconnect khi mạng trở lại
// ----------------------------------------------------------------
let _isConnected = false;
let _retryTimer = null;
const RETRY_DELAY = 5000; // ms

onValue(ref(db, '.info/connected'), snap => {
    const connected = snap.val() === true;

    if (connected === _isConnected) return;
    _isConnected = connected;

    // Thông báo cho tất cả listener đã đăng ký
    _connListeners.forEach(fn => fn(connected));

    if (!connected) {
        // Lên lịch reconnect
        clearTimeout(_retryTimer);
        _retryTimer = setTimeout(() => {
            goOffline(db);
            setTimeout(() => goOnline(db), 500);
        }, RETRY_DELAY);
    } else {
        clearTimeout(_retryTimer);
    }
});

// Khi browser online trở lại, force reconnect ngay
window.addEventListener('online', () => {
    goOffline(db);
    setTimeout(() => goOnline(db), 300);
});

// ----------------------------------------------------------------
// Connection listener registry
// ----------------------------------------------------------------
const _connListeners = new Set();

/**
 * Đăng ký callback khi trạng thái kết nối thay đổi.
 * @param {function} fn - nhận (isConnected: boolean)
 * @returns unsubscribe function
 */
function onConnectionChange(fn) {
    _connListeners.add(fn);
    // Gọi ngay với trạng thái hiện tại
    fn(_isConnected);
    return () => _connListeners.delete(fn);
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function getRef(path) {
    return ref(db, `/devices/${DEVICE_ID}/${path}`);
}

function listenRef(path, callback) {
    return onValue(getRef(path), callback);
}

async function setRef(path, value) {
    await set(getRef(path), value);
}

async function updateRef(path, updates) {
    await update(getRef(path), updates);
}

async function pushRef(path, value) {
    await push(getRef(path), value);
}

async function readOnce(path) {
    return await get(getRef(path));
}

// ----------------------------------------------------------------
// Auth helpers
// ----------------------------------------------------------------

/**
 * Gọi ở đầu mỗi trang cần bảo vệ.
 * Nếu chưa đăng nhập → redirect về login.html tự động.
 * Resolve khi đã xác nhận đăng nhập xong.
 */
function requireAuth() {
    return new Promise((resolve, reject) => {
        const unsub = onAuthStateChanged(auth, user => {
            unsub();
            if (user) {
                resolve(user);
            } else {
                window.location.replace('login.html');
                reject(new Error('unauthenticated'));
            }
        });
    });
}

/**
 * Đăng xuất — gọi từ nút logout trên header.
 */
function doLogout() {
    signOut(auth).then(() => {
        window.location.replace('login.html');
    });
}

// ----------------------------------------------------------------
// Exports
// ----------------------------------------------------------------
export {
    db,
    DEVICE_ID,
    getRef,
    listenRef,
    setRef,
    updateRef,
    pushRef,
    readOnce,
    onConnectionChange,
    requireAuth,
    doLogout,
};