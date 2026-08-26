// tests/test_user_routes.js
// SOURCE: IP/pulse/auth_routes_design_2026-05-20.md §11-2 (AUTH-001~007)
//         + IP/pulse/cursor_prompts/03_user_routes.md §4
//
// 실행: cross-env NODE_ENV=test node tests/test_user_routes.js
// 방식: minimal express app + http 모듈 + mock pg(require.cache inject) + **진짜 Supabase JWT**.
//
// ★★ 세션64c — Firebase → Supabase 인증 전환(제이 확정 2026-08-24).
//   종전에는 `admin.auth().verifyIdToken` 을 monkey-patch 했다. 이제는 목업이 «필요 없다» —
//   HS256 서명은 비밀만 있으면 테스트에서 진짜로 만들 수 있고, 그러면
//   **검증이 실제로 도는지**까지 함께 확인된다(목업은 그걸 못 본다).
//   · 정상 토큰  = SUPABASE_JWT_SECRET 으로 서명
//   · 무효 토큰  = 다른 비밀로 서명   · 만료 토큰 = exp 를 과거로
//   · 오류 코드  = AUTH_REQUIRED → **AUTH_REQUIRED** · AUTH_INVALID → **AUTH_INVALID**

const assert = require('assert');
const http = require('http');
const path = require('path');

// ============================================================
// 1. Supabase JWT — 목업이 아니라 «진짜 토큰»을 만든다
// ============================================================
const jwt = require('jsonwebtoken');

const SB_SECRET = 'test-supabase-jwt-secret-0123456789';
const SB_WRONG_SECRET = 'someone-elses-secret-9876543210';
process.env.SUPABASE_JWT_SECRET = SB_SECRET;

/** 지금 로그인한 사람. Firebase 판의 `mockDecoded` 자리를 대신한다. */
let currentIdentity = null;
/** 'invalid'(다른 비밀로 서명) | 'expired'(exp 과거) | null(정상) */
let tokenDefect = null;

/**
 * 실제 Supabase access token 과 같은 클레임 구조로 서명한다.
 * 근거: `@supabase/auth-js` types.d.ts:1622 RequiredClaims
 *       { iss, sub, aud, exp, iat, role, aal, session_id } — **`sub` 가 user id** 이고
 *       `email` 은 «선택» 클레임이다(:1641).
 */
function mintToken() {
    const now = Math.floor(Date.now() / 1000);
    const id = currentIdentity || { uid: 'unknown', email: null };
    const expired = tokenDefect === 'expired';
    return jwt.sign({
        iss: 'https://lrnuqhpgyuizfggxgxpl.supabase.co/auth/v1',
        sub: id.uid,
        aud: 'authenticated',
        role: 'authenticated',
        aal: 'aal1',
        session_id: 'ffffffff-1111-4222-8333-444444444444',
        email: id.email || undefined,
        iat: expired ? now - 7200 : now,
        exp: expired ? now - 3600 : now + 3600,
    }, tokenDefect === 'invalid' ? SB_WRONG_SECRET : SB_SECRET,
    { algorithm: 'HS256', noTimestamp: true });
}

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
}

async function executeMockQuery(sql, params = []) {
    const normalized = sql.trim().replace(/\s+/g, ' ');
    state.calls.push({ sql: normalized, params: params || [] });

    if (/^BEGIN/i.test(normalized)) return { rows: [] };
    if (/^COMMIT/i.test(normalized)) return { rows: [] };
    if (/^ROLLBACK/i.test(normalized)) return { rows: [] };

    // POST /me UPSERT: INSERT INTO users ... ON CONFLICT (supabase_uid) DO NOTHING RETURNING user_id
    if (/INSERT INTO users.*ON CONFLICT/i.test(normalized)) {
        const [uid, email, display_name, profile_type] = params;
        if (state.usersByUid.has(uid)) {
            return { rows: [] }; // conflict — 빈 RETURNING
        }
        const userId = state.nextUserId++;
        const row = {
            user_id: userId,
            supabase_uid: uid,
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

    // SELECT user_id FROM users WHERE supabase_uid = $1 (ON CONFLICT 폴백 / grant·revoke 핸들러)
    if (/SELECT user_id FROM users WHERE supabase_uid/i.test(normalized)) {
        const uid = params[0];
        const row = state.usersByUid.get(uid);
        return { rows: row ? [{ user_id: row.user_id }] : [] };
    }

    // SELECT * FROM users WHERE supabase_uid = $1 (GET /me)
    if (/SELECT \* FROM users WHERE supabase_uid/i.test(normalized)) {
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

    // PATCH /me — UPDATE users SET ... WHERE supabase_uid = $N RETURNING *
    if (/UPDATE users SET .* WHERE supabase_uid/i.test(normalized) && /RETURNING/i.test(normalized)) {
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
            state.usersByUid.delete(row.supabase_uid);
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
        // ★ 테스트가 적어 둔 `Bearer <아무거나>` 를 **실제 서명 토큰**으로 갈아 넣는다.
        //   (현재 신원 currentIdentity + 결함 tokenDefect 로 매번 새로 서명한다.)
        //   `authorization` 키가 아예 «없는» 케이스는 그대로 둔다 — 그게 401 AUTH_REQUIRED 축이다.
        if (typeof reqHeaders.authorization === 'string') {
            reqHeaders.authorization = `Bearer ${mintToken()}`;
        }
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
        tokenDefect = null;
        currentIdentity = { uid: 'uid_001', email: 'a@b.com' };

        const res = await request(
            'POST',
            '/api/users/me',
            { authorization: 'Bearer valid_token' },
            { display_name: '제이', profile_type: 'adult' }
        );

        assert.strictEqual(res.status, 201, `status should be 201, got ${res.status}`);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.meta.created, true);
        assert.strictEqual(res.body.data.supabase_uid, 'uid_001');
        assert.strictEqual(state.usersByUid.size, 1);
        assert.strictEqual(state.pulseConsents.length, 0, 'no consent recorded');
    });

    // AUTH-002: POST /me, 신규, v2 동의 → 201 + pulse_consents 1건(grant)
    await record('[2/7] AUTH-002 POST /me, 신규, v2 동의 → 201 + grant 1건', async () => {
        resetState();
        tokenDefect = null;
        currentIdentity = { uid: 'uid_002', email: 'b@c.com' };

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
        tokenDefect = null;
        currentIdentity = { uid: 'uid_003', email: 'c@d.com' };

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
        tokenDefect = null;
        currentIdentity = { uid: 'uid_004', email: 'd@e.com' };

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

    // AUTH-005: 토큰 없음 → 401 AUTH_REQUIRED
    await record('[5/7] AUTH-005 POST /me, Authorization 헤더 없음 → 401 AUTH_REQUIRED', async () => {
        resetState();
        const res = await request('POST', '/api/users/me', {}, {});
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.success, false);
        assert.strictEqual(res.body.error.code, 'AUTH_REQUIRED');
        assert.strictEqual(state.usersByUid.size, 0, 'no user created on auth failure');
    });

    // AUTH-006: 무효 토큰 (verifyIdToken throw) → 401 AUTH_INVALID
    await record('[6/7] AUTH-006 POST /me, 무효 토큰 → 401 AUTH_INVALID', async () => {
        resetState();
        tokenDefect = 'invalid';

        const res = await request(
            'POST',
            '/api/users/me',
            { authorization: 'Bearer invalid_token' },
            {}
        );

        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.error.code, 'AUTH_INVALID');
        assert.strictEqual(state.usersByUid.size, 0);

        tokenDefect = null;
    });

    // AUTH-007: 만료 토큰 → 401 AUTH_INVALID
    // ★ 세션64c — Firebase 판에서는 만료를 «표현할 수 없어» 무효 토큰으로 대신했다
    //   (Admin SDK 가 둘 다 throw 로 처리했다). 이제는 exp 를 과거로 두어 **진짜 만료 토큰**을
    //   보낸다. 즉 이 테스트가 「exp 검증이 켜져 있는가」를 실제로 본다.
    await record('[7/7] AUTH-007 POST /me, 만료 토큰 → 401 AUTH_INVALID', async () => {
        resetState();
        currentIdentity = { uid: 'uid_007', email: 'g@h.com' };
        tokenDefect = 'expired';

        const res = await request(
            'POST',
            '/api/users/me',
            { authorization: 'Bearer expired_token' },
            {}
        );

        assert.strictEqual(res.status, 401, `만료 토큰이 통과했다 — exp 검증이 꺼졌다: ${res.status}`);
        assert.strictEqual(res.body.error.code, 'AUTH_INVALID');
        assert.strictEqual(state.usersByUid.size, 0, '401 인데 users 행이 생겼다');

        tokenDefect = null;
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
