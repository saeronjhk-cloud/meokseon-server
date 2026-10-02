/**
 * 73-brand-junk-cleanup.js — products.brand / manufacturer 의 «반품·교환 문장 잔해» 정리 (세션73 U72-6)
 * =============================================================================
 * 왜: 파서(extractProductMeta)가 「반품 및 교환 판매원 및 구입처 …」의 「판매원」을 회사 라벨로 읽어
 *     brand 에 「및 구입처 내」(운영 306268) 같은 값을 넣었다. 파서는 세션73 에서 고쳤지만,
 *     저장은 COALESCE(brand, $new) 라 «이미 들어간 잔해는 다음 제보가 못 고친다». 그래서 한 번 지운다.
 *
 * 판정(값만 본다 · 파서 rejectCompanyValue ②③ 과 같은 축 + 안내 문구 단어):
 *   ① 접속어로 시작: 및 · 또는 · 에서
 *   ② 안내 문장 단어 포함: 반품 · 교환 · 구입처 · 그입처 · 소비자상담 · 고객상담 · 소비기한 · 유통기한
 *   ③ 한글·영문·숫자가 하나도 없음(기호 잔해)
 *
 * 사용(Railway 콘솔 · 명령에 한글 0):
 *   node /app/scripts/73-brand-junk-cleanup.js            ← 기본 = 읽기 전용(목록만)
 *   node /app/scripts/73-brand-junk-cleanup.js --apply    ← 목록의 칸을 NULL 로(트랜잭션 · 바뀐 행 수 출력)
 * ⚠ 지우기만 한다(추정값으로 채우지 않는다). 다음 정상 제보가 COALESCE 로 다시 채운다.
 */
const db = require('../src/config/database');

const JUNK_START = /^(및|또는|에서)(\s|$)/;            // 및 · 또는 · 에서
const JUNK_WORDS = new RegExp([
  '반품', '교환', '구입처', '그입처', // 반품 교환 구입처 그입처
  '소비자상담', '고객상담',             // 소비자상담 고객상담
  '소비기한', '유통기한',                   // 소비기한 유통기한
].join('|'));
const HAS_WORD = /[가-힣A-Za-z0-9]/;

function isJunk(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  if (!s) return false;
  return JUNK_START.test(s) || JUNK_WORDS.test(s) || !HAS_WORD.test(s);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const r = await db.query(
    `SELECT product_id, barcode, product_name, brand, manufacturer, data_source
       FROM products WHERE brand IS NOT NULL OR manufacturer IS NOT NULL`);
  const hits = [];
  for (const row of r.rows) {
    for (const field of ['brand', 'manufacturer']) {
      if (isJunk(row[field])) hits.push({ product_id: row.product_id, barcode: row.barcode, product_name: row.product_name, data_source: row.data_source, field, value: row[field] });
    }
  }
  console.log(`SCANNED ${r.rows.length} · JUNK ${hits.length}`);
  for (const h of hits) console.log('JUNK', JSON.stringify(h));
  if (!apply) { console.log('DRY-RUN (no change). Re-run with --apply to set these fields NULL.'); return; }
  let changed = 0;
  await db.transaction(async (client) => {
    for (const h of hits) {
      const u = await client.query(
        `UPDATE products SET ${h.field === 'brand' ? 'brand' : 'manufacturer'} = NULL, updated_at = NOW()
          WHERE product_id = $1 AND ${h.field === 'brand' ? 'brand' : 'manufacturer'} = $2`,
        [h.product_id, h.value]);
      changed += (u && u.rowCount) || 0;
    }
  });
  console.log(`APPLIED ${changed}`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
module.exports = { isJunk };
