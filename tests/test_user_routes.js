// tests/test_user_routes.js
// SOURCE: IP/pulse/auth_routes_design_2026-05-20.md §11-2 (AUTH-001~007)
//         + IP/pulse/cursor_prompts/03_user_routes.md §4
//
// 실행: cross-env NODE_ENV=test node tests/test_user_routes.js
// 방식: minimal express app + http 모듈 + mock pg(require.cache inject) + firebase-admin v12 monkey-patch.

const assert = require('assert');
const http = require('http');
const path = require('path');

// ============================================================
// 1. firebase-admin v12 monkey-patch (01번 학습 — Object.defineProperty 필요)
// ============================================================
const admin = require('firebase-admin');

let mockDecoded = null;
let mockShouldThrow = false;
let mockShouldDeleteUserThrow = false;
const deleteUserCalls = [];

Object.defineProperty(admin, 'auth', {
    value: function () {
        return {
            verifyIdToken: async (_token) => {
                if (mockShouldThrow) throw new Error('mock invalid token');
                return mockDecoded;
            },
            deleteUser: async (uid) => {
                deleteUserCalls.push(uid);
                if (mockShouldDeleteUserThrow) throw new Error('mock firebase delete failure');
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
// 3. Mock pg client + database 모듈 — require.cache inject
// ============================================================
//    state 객체는 모듈 외부에 두고, mockDb 메서드가 참조 (테스트마다 reset).
const state = {
    calls: [],
    usersByUid: new Map(),
    usersById: new Map(),
    pulseConsents: [],
    nextUserId: 1,
};

function resetState() {
    state.calls.length = 0;
    state.usersByUid.clear();
    state.usersById.clear();
    state.pulseConsents.length = 0;
    state.nextUserId = 1;
    deleteUserCalls.length = 0;
}

async function executeMockQuery(sql, params = []) {
    const normalized = sql.trim().replace(/\s+/g, ' ');
    state.calls.push({ sql: normalized, params: params || [] });

    if (/^BEGIN/i.test(normalized)) return { rows: [] };
    if (/^COMMIT/i.test(normalized)) return { rows: [] };
    if (/^ROLLBACK/i.test(normalized)) return { rows: [] };

    // POST /me UPSERT: INSERT INTO users ... ON CONFLICT (firebase_uid) DO NOTHING RETURNING user_id
    if (/INSERT INTO users.*ON CONFLICT/i.test(normalized)) {
        const [uid, email, display_name, profile_type] = params;
        if (state.usersByUid.has(uid)) {
            return { rows: [] }; // conflict — 빈 RETURNING
        }
        const userId = state.nextUserId++;
        const row = {
            user_id: userId,
            firebase_uid: uid,
            email: email || null,
            display_name: display_name || null,
            profile_type: profile_type || 'adult',
            pulse_consent_version: null,
        };
        state.usersByUid.set(uid, row);
        state.usersById.set(userId, row);
        return { rows: [{ user_id: userId }] };
    }

    // SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE (recordGrant/Revoke 의 row lock)
    if (/SELECT user_id FROM users WHERE user_id = \$1 FOR UPDATE/i.test(normalized)) {
        const userId = params[0];
        const row = state.usersById.get(userId);
        return { rows: row ? [{ user_id: row.user_id }] : [] };
    }

    // SELECT user_id FROM users WHERE firebase_uid = $1 (ON CONFLICT 폴백 / grant·revoke 핸들러)
    if (/SELECT user_id FROM users WHERE firebase_uid/i.test(normalized)) {
        const uid = params[0];
        const row = state.usersByUid.get(uid);
        return { rows: row ? [{ user_id: row.user_id }] : [] };
    }

    // SELECT * FROM users WHERE firebase_uid = $1 (GET /me)
    if (/SELECT \* FROM users WHERE firebase_uid/i.test(normalized)) {
        const uid = params[0];
        const row = state.usersByUid.get(uid);
        return { rows: row ? [row] : [] };
    }

    // SELECT * FROM users WHERE user_id = $1 (POST /me 응답 조회)
    if (/SELECT \* FROM users WHERE user_id/i.test(normalized)) {
        const userId = params[0];
        const row = state.usersById.get(userId);
        return { rows: row ? [row] : [] };
    }

    // UPDATE users SET pulse_consent_version (recordGrant: [userId, version] / recordRevoke: [userId])
    if (/UPDATE users SET pulse_consent_version/i.test(normalized)) {
        const userId = params[0];
        const row = state.usersById.get(userId);
        if (row) {
            row.pulse_consent_version = /= NULL/i.test(normalized) ? null : params[1];
        }
        return { rows: [] };
    }

    // PATCH /me — UPDATE users SET ... WHERE firebase_uid = $N RETURNING *
    if (/UPDATE users SET .* WHERE firebase_uid/i.test(normalized) && /RETURNING/i.test(normalized)) {
        const uid = params[params.length - 1];
        const row = state.usersByUid.get(uid);
        if (!row) return { rows: [] };
        const setMatch = normalized.match(/SET (.+) WHERE/i);
        if (setMatch) {
            const parts = setMatch[1].split(',').map((s) => s.trim());
            for (const part of parts) {
                const m = part.match(/^(\w+)\s*=\s*\$(\d+)/);
                if (m) {
                    const col = m[1];
                    const paramIdx = parseInt(m[2], 10) - 1;
                    row[col] = params[paramIdx];
                }
            }
        }
        return { rows: [row] };
    }

    // INSERT INTO pulse_consents (audit log)
    if (/INSERT INTO pulse_consents/i.test(normalized)) {
        const eventType = /'grant'/i.test(normalized) ? 'grant' : 'revoke';
        state.pulseConsents.push({
            user_id: params[0],
            consent_version: params[1],
            consent_scope: params[2],
            event_type: eventType,
            client_ip_hash: params[3],
            user_agent: params[4],
        });
        return { rows: [] };
    }

    // DELETE /me — DELETE FROM users WHERE user_id = $1
    if (/DELETE FROM users WHERE user_id/i.test(normalized)) {
        const userId = params[0];
        const row = state.usersById.get(userId);
        if (row) {
            state.usersById.delete(userId);
            state.usersByUid.delete(row.firebase_uid);
        }
        return { rows: [] };
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

// userRoutes 가 require 하기 전에 database 모듈 자리를 mock 으로 교체.
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
// 4. minimal express app + userRoutes 마운트
// ============================================================
const express = require('express');
const userRoutes = require('../src/routes/userRoutes');

const app = express();
app.use(express.json());
app.use('/api/users', userRoutes);
// 간이 errorHandler (실제 errorHandler 스타일과 일치)
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

// ============================================================
// 5. 테스트 실행 (AUTH-001 ~ AUTH-007)
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

    console.log('\n👤 User Routes 통합 테스트\n');

    // AUTH-001: POST /me, 신규, 동의 없음 → 201 created
    await record('[1/7] AUTH-001 POST /me, 신규, 동의 안 함 → 201 + meta.created=true', async () => {
        resetState();
        mockShouldThrow = false;
        mockDecoded = { uid: 'uid_001', email: 'a@b.com', name: '제이' };

        const res = await request(
            'POST',
            '/api/users/me',
            { authorization: 'Bearer valid_token' },
            { display_name: '제이', profile_type: 'adult' }
        );

        assert.strictEqual(res.status, 201, `status should be 201, got ${res.status}`);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.meta.created, true);
        assert.strictEqual(res.body.data.firebase_uid, 'uid_001');
        assert.strictEqual(state.usersByUid.size, 1);
        assert.strictEqual(state.pulseConsents.length, 0, 'no consent recorded');
    });

    // AUTH-002: POST /me, 신규, v2 동의 → 201 + pulse_consents 1건(grant)
    await record('[2/7] AUTH-002 POST /me, 신규, v2 동의 → 201 + grant 1건', async () => {
        resetState();
        mockShouldThrow = false;
        mockDecoded = { uid: 'uid_002', email: 'b@c.com', name: '비' };

        const res = await request(
            'POST',
            '/api/users/me',
            { authorization: 'Bearer valid_token' },
            { pulse_consent_version: 'v2' }
        );

        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.meta.created, true);
        assert.strictEqual(state.pulseConsents.length, 1);
        assert.strictEqual(state.pulseConsents[0].event_type, 'grant');
        assert.strictEqual(state.pulseConsents[0].consent_version, 'v2');
        assert.strictEqual(state.pulseConsents[0].consent_scope, 'b2b_aggregate_insights');
        // users.pulse_consent_version 도 SET 되었는지
        const user = state.usersByUid.get('uid_002');
        assert.strictEqual(user.pulse_consent_version, 'v2');
    });

    // AUTH-003: 기존 사용자 재호출 → 200 + meta.created=false
    await record('[3/7] AUTH-003 POST /me, 기존 사용자 재호출 → 200 + created=false', async () => {
        resetState();
        mockShouldThrow = false;
        mockDecoded = { uid: 'uid_003', email: 'c@d.com', name: '씨' };

        const res1 = await request(
            'POST',
            '/api/users/me',
            { authorization: 'Bearer t' },
            {}
        );
        assert.strictEqual(res1.status, 201);
        assert.strictEqual(res1.body.meta.created, true);

        const res2 = await request(
            'POST',
            '/api/users/me',
            { authorization: 'Bearer t' },
            {}
        );
        assert.strictEqual(res2.status, 200, `2nd call should be 200, got ${res2.status}`);
        assert.strictEqual(res2.body.meta.created, false);
        assert.strictEqual(state.usersByUid.size, 1, 'still 1 user');
    });

    // AUTH-004: 동시 호출 (Promise.all) → ON CONFLICT 로 1건만 INSERT, 양쪽 모두 200/201
    await record('[4/7] AUTH-004 POST /me, 동시 호출 (race) → users 1건, 양쪽 정상', async () => {
        resetState();
        mockShouldThrow = false;
        mockDecoded = { uid: 'uid_004', email: 'd@e.com', name: '디' };

        const [res1, res2] = await Promise.all([
            request('POST', '/api/users/me', { authorization: 'Bearer t1' }, {}),
            request('POST', '/api/users/me', { authorization: 'Bearer t2' }, {}),
        ]);

        // 둘 다 success
        assert.ok([200, 201].includes(res1.status), `res1 status ${res1.status}`);
        assert.ok([200, 201].includes(res2.status), `res2 status ${res2.status}`);
        assert.strictEqual(res1.body.success, true);
        assert.strictEqual(res2.body.success, true);
        // 한 호출은 created=true, 다른 호출은 created=false (XOR)
        const createdFlags = [res1.body.meta.created, res2.body.meta.created];
        assert.deepStrictEqual(
            createdFlags.slice().sort(),
            [false, true],
            'exactly one call should be the creator'
        );
        // users 1건만
        assert.strictEqual(state.usersByUid.size, 1);
    });

    // AUTH-005: 토큰 없음 → 401 NO_TOKEN
    await record('[5/7] AUTH-005 POST /me, Authorization 헤더 없음 → 401 NO_TOKEN', async () => {
        resetState();
        const res = await request('POST', '/api/users/me', {}, {});
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.success, false);
        assert.strictEqual(res.body.error.code, 'NO_TOKEN');
        assert.strictEqual(state.usersByUid.size, 0, 'no user created on auth failure');
    });

    // AUTH-006: 무효 토큰 (verifyIdToken throw) → 401 INVALID_TOKEN
    await record('[6/7] AUTH-006 POST /me, 무효 토큰 → 401 INVALID_TOKEN', async () => {
        resetState();
        mockShouldThrow = true;

        const res = await request(
            'POST',
            '/api/users/me',
            { authorization: 'Bearer invalid_token' },
            {}
        );

        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.error.code, 'INVALID_TOKEN');
        assert.strictEqual(state.usersByUid.size, 0);

        mockShouldThrow = false;
    });

    // AUTH-007: 만료 토큰 (verifyIdToken throw, 시나리오상 만료) → 401 INVALID_TOKEN
    //           Firebase Admin SDK는 만료/무효 모두 verifyIdToken throw로 처리하므로 동일 분기.
    await record('[7/7] AUTH-007 POST /me, 만료 토큰 → 401 INVALID_TOKEN', async () => {
        resetState();
        mockShouldThrow = true;

        const res = await request(
            'POST',
            '/api/users/me',
            { authorization: 'Bearer expired_token' },
            {}
        );

        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.error.code, 'INVALID_TOKEN');

        mockShouldThrow = false;
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
