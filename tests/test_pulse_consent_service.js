// tests/test_pulse_consent_service.js
// SOURCE: IP/pulse/auth_routes_design_2026-05-20.md §11-1 (PCS-001~005)
//         + IP/pulse/cursor_prompts/02_pulse_consent_service.md §4
//
// 실행: cross-env NODE_ENV=test node tests/test_pulse_consent_service.js
// 모킹: in-memory pg client (실제 DB 호출 없이 SQL 패턴·파라미터·호출 순서만 검증)

const assert = require('assert');
const pulseConsentService = require('../src/services/pulseConsentService');

/**
 * In-memory mock pg client.
 * @param {Object} rowsMap - { sql_substring: { rows: [...] } } 형태로 미리 응답 정의
 * @returns {Object} { calls: [{ sql, params }], query(sql, params) }
 */
function createMockClient(rowsMap = {}) {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            // trim + 공백 정규화 후 기록 (assertion 일관성용)
            calls.push({ sql: sql.trim().replace(/\s+/g, ' '), params: params || [] });
            for (const [pattern, response] of Object.entries(rowsMap)) {
                if (sql.includes(pattern)) {
                    return response;
                }
            }
            return { rows: [] }; // default (UPDATE/INSERT 등)
        },
    };
}

async function run() {
    let passed = 0;
    let failed = 0;

    console.log('\n🔐 PulseConsentService 단위 테스트\n');

    // PCS-001: recordGrant — SELECT FOR UPDATE → UPDATE users → INSERT pulse_consents(grant)
    {
        const db = createMockClient();
        try {
            await pulseConsentService.recordGrant(db, 1, 'v2', { user_agent: 'TestAgent/1.0' });

            assert.strictEqual(db.calls.length, 3, 'must issue 3 queries (lock + update + insert)');
            assert.ok(db.calls[0].sql.includes('FOR UPDATE'), 'first call must be row lock');
            assert.deepStrictEqual(db.calls[0].params, [1]);

            assert.ok(db.calls[1].sql.includes('UPDATE users'), 'second call must be UPDATE users');
            assert.ok(db.calls[1].sql.includes('pulse_consent_version'), 'must set pulse_consent_version');
            assert.deepStrictEqual(db.calls[1].params, [1, 'v2']);

            assert.ok(db.calls[2].sql.includes('INSERT INTO pulse_consents'), 'third call must be INSERT');
            assert.ok(db.calls[2].sql.includes("'grant'"), 'event_type must be grant');
            assert.deepStrictEqual(db.calls[2].params, [1, 'v2', 'b2b_aggregate_insights', null, 'TestAgent/1.0']);

            console.log('  ✅ [1/5] PCS-001 recordGrant → SELECT FOR UPDATE + UPDATE + INSERT(grant)');
            passed++;
        } catch (e) {
            console.log('  ❌ [1/5] PCS-001:', e.message);
            failed++;
        }
    }

    // PCS-002: recordGrant 후 recordRevoke → users.pulse_consent_version = NULL, INSERT 2건
    {
        const db = createMockClient();
        try {
            await pulseConsentService.recordGrant(db, 2, 'v2', {});
            await pulseConsentService.recordRevoke(db, 2, 'v2', {});

            assert.strictEqual(db.calls.length, 6, 'must issue 6 queries (3 per call)');

            // recordRevoke의 UPDATE(5번째)는 NULL로 설정
            const revokeUpdate = db.calls[4];
            assert.ok(revokeUpdate.sql.includes('UPDATE users'), '5th call must be UPDATE');
            assert.ok(revokeUpdate.sql.includes('= NULL'), 'must set pulse_consent_version = NULL');
            assert.deepStrictEqual(revokeUpdate.params, [2]);

            // recordRevoke의 INSERT(6번째)는 event_type=revoke
            const revokeInsert = db.calls[5];
            assert.ok(revokeInsert.sql.includes('INSERT INTO pulse_consents'), '6th call must be INSERT');
            assert.ok(revokeInsert.sql.includes("'revoke'"), 'event_type must be revoke');

            console.log('  ✅ [2/5] PCS-002 recordGrant + recordRevoke → 2 events (grant, revoke)');
            passed++;
        } catch (e) {
            console.log('  ❌ [2/5] PCS-002:', e.message);
            failed++;
        }
    }

    // PCS-003: recordGrant 두 번 (v2 → v2) — UPDATE 멱등, INSERT 2건 (모두 grant, audit log)
    {
        const db = createMockClient();
        try {
            await pulseConsentService.recordGrant(db, 3, 'v2', {});
            await pulseConsentService.recordGrant(db, 3, 'v2', {});

            assert.strictEqual(db.calls.length, 6, 'must issue 6 queries');

            // 두 번의 INSERT 모두 event_type='grant'
            const insert1 = db.calls[2];
            const insert2 = db.calls[5];
            assert.ok(
                insert1.sql.includes("'grant'") && insert2.sql.includes("'grant'"),
                'both INSERTs must be grant (audit log retains all events)'
            );

            console.log('  ✅ [3/5] PCS-003 recordGrant 2회 → UPDATE 멱등, INSERT 2건(grant×2)');
            passed++;
        } catch (e) {
            console.log('  ❌ [3/5] PCS-003:', e.message);
            failed++;
        }
    }

    // PCS-004: getCurrentConsent — 미동의 사용자는 null
    {
        const db = createMockClient({
            'SELECT pulse_consent_version FROM users': { rows: [{ pulse_consent_version: null }] },
        });
        try {
            const result = await pulseConsentService.getCurrentConsent(db, 4);
            assert.strictEqual(result, null, 'unconsented user must return null');
            assert.strictEqual(db.calls.length, 1);
            assert.ok(db.calls[0].sql.includes('SELECT pulse_consent_version'), 'must SELECT pulse_consent_version');
            assert.deepStrictEqual(db.calls[0].params, [4]);

            console.log('  ✅ [4/5] PCS-004 getCurrentConsent (미동의) → null');
            passed++;
        } catch (e) {
            console.log('  ❌ [4/5] PCS-004:', e.message);
            failed++;
        }
    }

    // PCS-005: getConsentHistory — event_at DESC 정렬 SQL 발행
    {
        const fakeHistory = [
            { consent_version: 'v2', consent_scope: 'b2b_aggregate_insights', event_type: 'revoke', event_at: '2026-05-20T00:00:00Z', user_agent: null },
            { consent_version: 'v2', consent_scope: 'b2b_aggregate_insights', event_type: 'grant', event_at: '2026-05-19T00:00:00Z', user_agent: null },
        ];
        const db = createMockClient({
            'SELECT consent_version': { rows: fakeHistory },
        });
        try {
            const result = await pulseConsentService.getConsentHistory(db, 5);

            assert.strictEqual(result.length, 2);
            assert.strictEqual(result[0].event_type, 'revoke');
            assert.strictEqual(result[1].event_type, 'grant');

            // SQL이 ORDER BY event_at DESC 포함
            assert.ok(db.calls[0].sql.includes('ORDER BY event_at DESC'), 'SQL must include ORDER BY event_at DESC');
            assert.deepStrictEqual(db.calls[0].params, [5]);

            console.log('  ✅ [5/5] PCS-005 getConsentHistory → event_at DESC 정렬');
            passed++;
        } catch (e) {
            console.log('  ❌ [5/5] PCS-005:', e.message);
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
