// tests/test_firebase_auth.js
// SOURCE: IP/pulse/auth_routes_design_2026-05-20.md §11-2 (AUTH-005, AUTH-006, AUTH-007)
//         + IP/pulse/cursor_prompts/01_firebase_admin.md §4
//
// 실행: NODE_ENV=test node tests/test_firebase_auth.js
// 모킹: firebase-admin의 admin.auth()를 monkey-patch (sinon 미사용)

const assert = require('assert');

// ── firebase-admin monkey-patch ──
// require('../src/config/firebase') 보다 먼저 admin.auth를 덮어써야
// initFirebase()가 NODE_ENV=test 분기로 우회된 후에도 getAdmin().auth()가 mock을 가리킴.
//
// ★ 2026-05-25 fix: firebase-admin v12에서 admin.auth는 getter-only property라
// 단순 할당(`admin.auth = ...`)이 silently 무시됨. Object.defineProperty로 강제 덮어쓰기.
const admin = require('firebase-admin');
let mockDecoded = null;
let mockShouldThrow = false;

Object.defineProperty(admin, 'auth', {
    value: function () {
        return {
            verifyIdToken: async (_token) => {
                if (mockShouldThrow) {
                    throw new Error('mock invalid token');
                }
                return mockDecoded;
            },
        };
    },
    writable: true,
    configurable: true,
});

// ── Service Account 더미 (NODE_ENV=test 분기에서 실제로 사용되지 않음) ──
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'test',
});

// ── 모듈 로드 ──
const { initFirebase } = require('../src/config/firebase');
const { firebaseAuth, firebaseAuthOptional } = require('../src/middleware/firebaseAuth');

// NODE_ENV=test 분기로 admin.initializeApp 우회 + initialized=true.
// 이후 getAdmin() 호출 시 monkey-patched admin 객체 반환.
initFirebase();

function mockReqRes(authHeader) {
    const req = { headers: authHeader ? { authorization: authHeader } : {} };
    const res = {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };
    return { req, res };
}

async function run() {
    let passed = 0;
    let failed = 0;

    console.log('\n🔐 Firebase Auth Middleware 테스트\n');

    // Case 1: NO_TOKEN — Authorization 헤더 없음
    {
        const { req, res } = mockReqRes(null);
        let nextCalled = false;
        await firebaseAuth(req, res, () => {
            nextCalled = true;
        });
        try {
            assert.strictEqual(res.statusCode, 401);
            assert.strictEqual(res.body.success, false);
            assert.strictEqual(res.body.error.code, 'NO_TOKEN');
            assert.strictEqual(nextCalled, false);
            console.log('  ✅ [1/5] NO_TOKEN — Authorization 헤더 없음');
            passed++;
        } catch (e) {
            console.log('  ❌ [1/5] NO_TOKEN — Authorization 헤더 없음:', e.message);
            failed++;
        }
    }

    // Case 2: NO_TOKEN — Bearer scheme 아님 (다른 scheme)
    {
        const { req, res } = mockReqRes('Basic xyz');
        let nextCalled = false;
        await firebaseAuth(req, res, () => {
            nextCalled = true;
        });
        try {
            assert.strictEqual(res.statusCode, 401);
            assert.strictEqual(res.body.error.code, 'NO_TOKEN');
            assert.strictEqual(nextCalled, false);
            console.log('  ✅ [2/5] NO_TOKEN — Bearer scheme 아님');
            passed++;
        } catch (e) {
            console.log('  ❌ [2/5] NO_TOKEN — Bearer scheme 아님:', e.message);
            failed++;
        }
    }

    // Case 3: INVALID_TOKEN — verifyIdToken throw
    {
        mockShouldThrow = true;
        const { req, res } = mockReqRes('Bearer invalid_token');
        let nextCalled = false;
        await firebaseAuth(req, res, () => {
            nextCalled = true;
        });
        try {
            assert.strictEqual(res.statusCode, 401);
            assert.strictEqual(res.body.error.code, 'INVALID_TOKEN');
            assert.strictEqual(nextCalled, false);
            console.log('  ✅ [3/5] INVALID_TOKEN — verifyIdToken 실패');
            passed++;
        } catch (e) {
            console.log('  ❌ [3/5] INVALID_TOKEN — verifyIdToken 실패:', e.message);
            failed++;
        }
        mockShouldThrow = false;
    }

    // Case 4: 정상 토큰 — next() 호출 + req.firebase 첨부
    {
        mockDecoded = { uid: 'test_uid_abc', email: 'test@example.com', name: '테스트' };
        const { req, res } = mockReqRes('Bearer valid_token');
        let nextCalled = false;
        await firebaseAuth(req, res, () => {
            nextCalled = true;
        });
        try {
            assert.strictEqual(nextCalled, true);
            assert.strictEqual(res.statusCode, null);
            assert.deepStrictEqual(req.firebase, {
                uid: 'test_uid_abc',
                email: 'test@example.com',
                name: '테스트',
            });
            console.log('  ✅ [4/5] 정상 토큰 — next() + req.firebase 첨부');
            passed++;
        } catch (e) {
            console.log('  ❌ [4/5] 정상 토큰 — next() + req.firebase 첨부:', e.message);
            failed++;
        }
    }

    // Case 5: firebaseAuthOptional — 토큰 없음 → 통과 + req.firebase=null
    {
        const { req, res } = mockReqRes(null);
        let nextCalled = false;
        await firebaseAuthOptional(req, res, () => {
            nextCalled = true;
        });
        try {
            assert.strictEqual(nextCalled, true);
            assert.strictEqual(req.firebase, null);
            assert.strictEqual(res.statusCode, null);
            console.log('  ✅ [5/5] Optional — 토큰 없음 통과 + req.firebase=null');
            passed++;
        } catch (e) {
            console.log('  ❌ [5/5] Optional — 토큰 없음 통과 + req.firebase=null:', e.message);
            failed++;
        }
    }

    console.log(`\n결과: ${passed}/${passed + failed} 통과, ${failed} 실패\n`);
    process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
    console.error('테스트 실행 오류:', err);
    process.exit(1);
});
