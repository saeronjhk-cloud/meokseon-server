// tests/test_scan_routes.js
// SOURCE: IP/pulse/auth_routes_design_2026-05-20.md §11-3 (SCAN-001~004)
//         + IP/pulse/cursor_prompts/04_scan_routes.md §4
//
// 실행: cross-env NODE_ENV=test node tests/test_scan_routes.js
// 방식: 03번 패턴 재사용 — minimal express app + http + mock pg(require.cache inject) + firebase-admin v12 monkey-patch.
//
// 핵심 검증: pulse_eligible 스냅샷 정책 (스캔 시점 동의 상태가 BOOLEAN 으로 박힘, 이후 동의 변경에 불변).

const assert = require('assert');
const http = require('http');
const path = require('path');

// ============================================================
// 1. firebase-admin v12 monkey-patch (01번 학습)
// ============================================================
const admin = require('firebase-admin');

let mockDecoded = null;
let mockShouldThrow = false;

Object.defineProperty(admin, 'auth', {
    value: function () {
        return {
            verifyIdToken: async (_token) => {
                if (mockShouldThrow) throw new Error('mock invalid token');
                return mockDecoded;
            },
        };
    },
    writable: true,
    configurable: true,
});

// ============================================================
// 2. NODE_ENV=test 분기 + initFirebase
// ============================================================
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'test',
});
require('../src/config/firebase').initFirebase();

// ============================================================
// 3. Mock pg client + database 모듈 — require.cache inject (03번 패턴)
// ============================================================
const state = {
    calls: [],
    // firebase_uid → { user_id, pulse_consent_version }
    usersByUid: new Map(),
    // scan_history rows (INSERT 순서대로)
    scans: [],
    nextScanId: 100,
};

function resetState() {
    state.calls.length = 0;
    state.usersByUid.clear();
    state.scans.length = 0;
    state.nextScanId = 100;
}

async function executeMockQuery(sql, params = []) {
    const normalized = sql.trim().replace(/\s+/g, ' ');
    state.calls.push({ sql: normalized, params: params || [] });

    // POST /scans 1) SELECT user_id, pulse_consent_version FROM users WHERE firebase_uid
    if (/SELECT user_id, pulse_consent_version FROM users WHERE firebase_uid/i.test(normalized)) {
        const uid = params[0];
        const user = state.usersByUid.get(uid);
        if (!user) return { rows: [] };
        return {
            rows: [{
                user_id: user.user_id,
                pulse_consent_version: user.pulse_consent_version,
            }],
        };
    }

    // GET /scans 1) SELECT user_id FROM users WHERE firebase_uid
    if (/SELECT user_id FROM users WHERE firebase_uid/i.test(normalized)) {
        const uid = params[0];
        const user = state.usersByUid.get(uid);
        return { rows: user ? [{ user_id: user.user_id }] : [] };
    }

    // POST /scans 2) INSERT INTO scan_history ... RETURNING scan_id, scanned_at, pulse_eligible
    if (/INSERT INTO scan_history/i.test(normalized)) {
        const [user_id, product_id, scan_type, pulse_eligible] = params;
        const scan = {
            scan_id: state.nextScanId++,
            user_id,
            product_id,
            scan_type,
            scanned_at: new Date().toISOString(),
            pulse_eligible: !!pulse_eligible,
        };
        state.scans.push(scan);
        return {
            rows: [{
                scan_id: scan.scan_id,
                scanned_at: scan.scanned_at,
                pulse_eligible: scan.pulse_eligible,
            }],
        };
    }

    // GET /scans 2) SELECT scan_id, product_id, scan_type, scanned_at, pulse_eligible FROM scan_history
    if (/SELECT scan_id, product_id, scan_type, scanned_at, pulse_eligible FROM scan_history/i.test(normalized)) {
        const [userId, limit, offset] = params;
        const userScans = state.scans
            .filter((s) => s.user_id === userId)
            .sort((a, b) => (a.scanned_at < b.scanned_at ? 1 : -1)) // DESC
            .slice(offset, offset + limit);
        return {
            rows: userScans.map((s) => ({
                scan_id: s.scan_id,
                product_id: s.product_id,
                scan_type: s.scan_type,
                scanned_at: s.scanned_at,
                pulse_eligible: s.pulse_eligible,
            })),
        };
    }

    return { rows: [] };
}

const mockClient = {
    query: executeMockQuery,
    release() {
        /* no-op */
    },
};

const mockDb = {
    pool: {
        async connect() {
            return mockClient;
        },
    },
    async query(sql, params) {
        return executeMockQuery(sql, params);
    },
    async transaction(cb) {
        await mockClient.query('BEGIN');
        try {
            const r = await cb(mockClient);
            await mockClient.query('COMMIT');
            return r;
        } catch (err) {
            await mockClient.query('ROLLBACK');
            throw err;
        }
    },
    healthCheck: async () => ({ status: 'healthy' }),
};

// scanRoutes 가 require 하기 전에 database 모듈을 mock 으로 교체.
const databasePath = require.resolve(path.join(__dirname, '..', 'src', 'config', 'database'));
require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: mockDb,
    children: [],
    paths: [],
};

// ============================================================
// 4. minimal express app + scanRoutes 마운트
// ============================================================
const express = require('express');
const scanRoutes = require('../src/routes/scanRoutes');

const app = express();
app.use(express.json());
app.use('/api/scans', scanRoutes);
app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({
        success: false,
        error: { code: err.code || 'INTERNAL_ERROR', message: err.message },
    });
});

const server = app.listen(0);

function request(method, urlPath, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const port = server.address().port;
        const reqHeaders = { ...headers };
        let bodyStr = null;
        if (body !== null) {
            bodyStr = JSON.stringify(body);
            reqHeaders['content-type'] = 'application/json';
            reqHeaders['content-length'] = Buffer.byteLength(bodyStr);
        }
        const req = http.request(
            { method, hostname: '127.0.0.1', port, path: urlPath, headers: reqHeaders },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    let parsed = null;
                    try {
                        parsed = data ? JSON.parse(data) : null;
                    } catch {
                        parsed = data;
                    }
                    resolve({ status: res.statusCode, body: parsed, headers: res.headers });
                });
            }
        );
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

// 헬퍼: in-memory users 직접 셋업.
function seedUser(uid, userId, consentVersion) {
    state.usersByUid.set(uid, { user_id: userId, pulse_consent_version: consentVersion });
}

// ============================================================
// 5. 테스트 실행 (SCAN-001 ~ SCAN-004)
// ============================================================
async function run() {
    let passed = 0;
    let failed = 0;
    const fails = [];

    function record(name, fn) {
        return fn()
            .then(() => {
                console.log(`  ✅ ${name}`);
                passed++;
            })
            .catch((e) => {
                console.log(`  ❌ ${name}: ${e.message}`);
                fails.push({ name, error: e });
                failed++;
            });
    }

    console.log('\n📷 Scan Routes 통합 테스트\n');

    // SCAN-001: 동의 사용자(v2) 스캔 → pulse_eligible=TRUE
    await record('[1/4] SCAN-001 동의 사용자(v2) 스캔 → pulse_eligible=TRUE, 201', async () => {
        resetState();
        mockShouldThrow = false;
        mockDecoded = { uid: 'uid_001', email: 'a@b.com', name: '동의자' };
        seedUser('uid_001', 1, 'v2');

        const res = await request(
            'POST',
            '/api/scans',
            { authorization: 'Bearer valid_token' },
            { product_id: 12345, scan_type: 'barcode' }
        );

        assert.strictEqual(res.status, 201, `status should be 201, got ${res.status}`);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.data.pulse_eligible, true, 'response pulse_eligible must be true');
        assert.strictEqual(state.scans.length, 1);
        assert.strictEqual(state.scans[0].pulse_eligible, true, 'DB row pulse_eligible must be true');
        assert.strictEqual(state.scans[0].user_id, 1);
        assert.strictEqual(state.scans[0].product_id, 12345);
        assert.strictEqual(state.scans[0].scan_type, 'barcode');
    });

    // SCAN-002: 미동의 사용자(NULL) 스캔 → pulse_eligible=FALSE
    await record('[2/4] SCAN-002 미동의 사용자(NULL) 스캔 → pulse_eligible=FALSE, 201', async () => {
        resetState();
        mockShouldThrow = false;
        mockDecoded = { uid: 'uid_002', email: 'b@c.com', name: '미동의자' };
        seedUser('uid_002', 2, null);

        const res = await request(
            'POST',
            '/api/scans',
            { authorization: 'Bearer valid_token' },
            { product_id: 99, scan_type: 'ocr' }
        );

        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.data.pulse_eligible, false);
        assert.strictEqual(state.scans.length, 1);
        assert.strictEqual(state.scans[0].pulse_eligible, false);
    });

    // SCAN-003: 동의→스캔(TRUE)→철회→스캔(FALSE), 첫 스캔은 그대로 TRUE (★ 스냅샷 정책)
    await record('[3/4] SCAN-003 동의→스캔→철회→스캔, 스냅샷 불변', async () => {
        resetState();
        mockShouldThrow = false;
        mockDecoded = { uid: 'uid_003', email: 'c@d.com', name: '토글러' };

        // 1) 동의 상태로 스캔
        seedUser('uid_003', 3, 'v2');
        const res1 = await request(
            'POST',
            '/api/scans',
            { authorization: 'Bearer t1' },
            { product_id: 1001, scan_type: 'barcode' }
        );
        assert.strictEqual(res1.status, 201);
        assert.strictEqual(res1.body.data.pulse_eligible, true, 'first scan must be eligible=true');

        const firstScanId = res1.body.data.scan_id;

        // 2) 철회 (state 직접 변경 — revoke API 호출 안 거치고 동의 토글 시뮬레이션)
        state.usersByUid.get('uid_003').pulse_consent_version = null;

        // 3) 미동의 상태로 두 번째 스캔
        const res2 = await request(
            'POST',
            '/api/scans',
            { authorization: 'Bearer t2' },
            { product_id: 1002, scan_type: 'barcode' }
        );
        assert.strictEqual(res2.status, 201);
        assert.strictEqual(res2.body.data.pulse_eligible, false, 'second scan must be eligible=false');

        // 4) 핵심: 첫 스캔 row 의 pulse_eligible 은 여전히 TRUE (스냅샷 불변)
        const firstScan = state.scans.find((s) => s.scan_id === firstScanId);
        assert.ok(firstScan, 'first scan row should exist');
        assert.strictEqual(firstScan.pulse_eligible, true, 'first scan pulse_eligible must stay TRUE after revoke');

        // 2 scans 총합
        assert.strictEqual(state.scans.length, 2);
    });

    // SCAN-004: users 테이블에 사용자 row 없음 → 404 USER_NOT_FOUND
    await record('[4/4] SCAN-004 users row 없음 → 404 USER_NOT_FOUND', async () => {
        resetState();
        mockShouldThrow = false;
        mockDecoded = { uid: 'uid_orphan', email: 'x@y.com', name: '미가입' };
        // seedUser 호출 안 함 → DB 에 users row 없음

        const res = await request(
            'POST',
            '/api/scans',
            { authorization: 'Bearer valid_token' },
            { product_id: 12345, scan_type: 'barcode' }
        );

        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.body.success, false);
        assert.strictEqual(res.body.error.code, 'USER_NOT_FOUND');
        assert.strictEqual(state.scans.length, 0, 'no scan should be inserted');
    });

    console.log(`\n결과: ${passed}/${passed + failed} 통과, ${failed} 실패`);
    if (failed > 0) {
        console.log('\n실패 상세:');
        for (const f of fails) {
            console.log(`  - ${f.name}`);
            console.log(`    ${f.error.stack || f.error.message}`);
        }
    }

    server.close();
    process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
    console.error('테스트 실행 오류:', err);
    server.close();
    process.exit(1);
});
