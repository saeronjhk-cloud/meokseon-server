// src/config/firebase.js
// SOURCE: IP/pulse/auth_routes_design_2026-05-20.md §2-3
//         + IP/pulse/cursor_prompts/01_firebase_admin.md §3-1, §4-2
//
// Firebase Admin SDK 초기화 모듈.
// - production/development: FIREBASE_SERVICE_ACCOUNT_JSON 환경변수에서 credential 로드.
// - test (NODE_ENV=test): initializeApp 우회 (테스트 코드가 admin.auth를 mock).

const admin = require('firebase-admin');

let initialized = false;

function initFirebase() {
    if (initialized) return admin;

    // 테스트 모드 — initializeApp 호출 우회. 테스트 코드가 admin.auth를 monkey-patch.
    // 다른 우회 절대 금지 (안티패턴 방지).
    if (process.env.NODE_ENV === 'test') {
        initialized = true;
        return admin;
    }

    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON env var required');
    }

    let credential;
    try {
        credential = admin.credential.cert(JSON.parse(serviceAccountJson));
    } catch (err) {
        throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON 파싱 실패: ${err.message}`);
    }

    admin.initializeApp({ credential });
    initialized = true;
    return admin;
}

function getAdmin() {
    if (!initialized) {
        throw new Error('Firebase Admin 초기화 안 됨. initFirebase()를 먼저 호출하세요.');
    }
    return admin;
}

module.exports = { initFirebase, getAdmin };
