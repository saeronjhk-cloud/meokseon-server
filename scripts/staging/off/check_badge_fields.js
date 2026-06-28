/**
 * check_badge_fields.js — §11① API 메타데이터 노출 검증(배포 전 로컬).
 * getProductWithTrafficLight 응답 nutrition 에 OFF 배지 필드가 실리는지 확인.
 * 사용:
 *   $env:DATABASE_URL="postgresql://...PUBLIC..."
 *   node scripts/staging/off/check_badge_fields.js 88002224 8801043012607
 */
const svc = require('../../../src/services/productService');

const FIELDS = ['source', 'off_grade', 'confidence', 'source_license', 'basis_confident'];
const bcs = process.argv.slice(2);
if (bcs.length === 0) bcs.push('88002224');

(async () => {
  let fail = 0;
  for (const bc of bcs) {
    try {
      const d = await svc.getProductWithTrafficLight(bc);
      const n = d.nutrition;
      console.log(`\n=== barcode=${bc} (${d.product.product_name}) ===`);
      if (!n) { console.log('  nutrition: null (영양 없음)'); continue; }
      for (const f of FIELDS) console.log(`  ${f}: ${JSON.stringify(n[f])}`);
      const present = FIELDS.every((f) => f in n);
      console.log(present ? '  [OK] 배지 필드 5종 모두 노출' : '  [XX] 필드 누락');
      if (!present) fail++;
      // OFF 제품이면 출처/라이선스 일관성
      if (n.source === 'openfoodfacts') {
        const consistent = n.confidence === 'low' && n.source_license === 'ODbL-1.0' && ['A', 'B'].includes(n.off_grade);
        console.log(consistent ? '  [OK] OFF 메타 일관(low·ODbL·A/B)' : '  [XX] OFF 메타 불일치');
        if (!consistent) fail++;
      }
    } catch (e) {
      console.error(`  ERROR ${bc}:`, e.message); fail++;
    }
  }
  console.log(`\n=== ${fail === 0 ? 'ALL GREEN ✅ — 배포 가능' : 'FAIL ✗ ' + fail} ===`);
  process.exit(fail ? 1 : 0);
})();
