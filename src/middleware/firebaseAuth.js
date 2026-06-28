// src/middleware/firebaseAuth.js
// SOURCE: IP/pulse/auth_routes_design_2026-05-20.md §3
//         + IP/pulse/cursor_prompts/01_firebase_admin.md §3-2
//
// Firebase ID Token 검증 미들웨어.
// - firebaseAuth: Authorization: Bearer <token> 필수. 실패 시 401.
// - firebaseAuthOptional: 토큰이 있으면 검증, 없으면 통과 (게스트 허용 라우트용).

const { getAdmin } = require('../config/firebase');
const logger = require('../config/logger');

/**
 * Firebase ID Token 검증 미들웨어.
 * Authorization: Bearer <token> 헤더 검증 후
 * req.firebase = { uid, email, name } 첨부.
 */
async function firebaseAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            error: { code: 'NO_TOKEN', message: '인증 토큰이 없습니다.' },
        });
    }

    const idToken = authHeader.slice('Bearer '.length).trim();

    try {
        const decoded = await getAdmin().auth().verifyIdToken(idToken);
        req.firebase = {
            uid: decoded.uid,
            email: decoded.email || null,
            name: decoded.name || null,
        };
        return next();
    } catch (err) {
        // 토큰 값 자체는 로깅하지 않음 (보안).
        logger.warn('Firebase token verification failed', { error: err.message });
        return res.status(401).json({
            success: false,
            error: { code: 'INVALID_TOKEN', message: '인증 토큰이 유효하지 않습니다.' },
        });
    }
}

/**
 * 옵션 인증 — 토큰이 있으면 검증, 없으면 통과 (req.firebase = null).
 * 게스트 사용 허용 라우트(예: 제품 검색)에서 사용.
 */
async function firebaseAuthOptional(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        req.firebase = null;
        return next();
    }
    return firebaseAuth(req, res, next);
}

module.exports = { firebaseAuth, firebaseAuthOptional };
