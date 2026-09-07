/**
 * 68-build-vision-eval.js — Vision 원문 기반 영양 파서 평가셋 v2 «생성기» (세션68 U67-15)
 * ============================================================================
 * 입력 : .tmp/s60/vision/raw/NNN.json.gz  (세션60 Google Vision 원본 67건 · 재과금 0)
 * 출력 : ../eval_set/vision_label_eval_v2.jsonl  (정본 · 저장소 «밖» · IP 분리)
 *        ./eval_set/vision_label_eval_v2.jsonl    (사본 · 저장소 «안» · CI 용)
 *
 * ★ truth 는 사람이 라벨 원문을 읽어 정했다. 검산이 되는 건은 4-9-4 로 교차 확인했다
 *   (예: 030 탄수 "29." → 2g ⇐ 19×9+13×4+2×4=231kcal 정합). 확인 안 되는 값은 null 로 두고
 *   «틀린 값»만 forbid 에 적었다 — 추정으로 truth 를 채우지 않는다(P1).
 *
 * 왜 텍스트를 jsonl 에 «내장»하나: `.tmp/` 는 커밋되지 않는다. v1 과 같은 이유다.
 *
 * 실행: node scripts/68-build-vision-eval.js   (한 번만. truth 를 고치면 다시)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RAW_DIR = path.join(__dirname, '..', '.tmp', 's60', 'vision', 'raw');
const OUT_CANON = path.join(__dirname, '..', '..', 'eval_set', 'vision_label_eval_v2.jsonl');
const OUT_REPO = path.join(__dirname, '..', 'eval_set', 'vision_label_eval_v2.jsonl');

function visionText(id) {
  const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RAW_DIR, id + '.json.gz'))));
  return d.fullTextAnnotation ? d.fullTextAnnotation.text : ((d.textAnnotations || [])[0] || {}).description || '';
}

// ── truth ─────────────────────────────────────────────────────────────────────
// class:  scatter(셀 세로 흩어짐) · g9(단위 g 를 9 로 오독) · decimal(소수점 손실) · glued(숫자 붙음)
//         absent(사진에 영양표 없음 — 정답은 «빈 결과») · 2col(우유 포함 2열 표) · label_incons(라벨 자체 모순)
//         partial_label(라벨이 일부 항목만 표기) · ok(대조군)
const CASES = [
  { id: '001', name: '신라면', cls: 'ok', basis: 'per_serving',
    n: { calories: 500, sodium: 1790, total_carbs: 79, total_sugars: 4, total_fat: 16, saturated_fat: 8, trans_fat: 0, cholesterol: 0, protein: 10 } },
  { id: '006', name: '대천김곱창김', cls: 'ok', basis: 'per_total',
    n: { calories: 155, sodium: 430, total_carbs: 12, total_sugars: 0, total_fat: 9, saturated_fat: 1.2, trans_fat: 0, cholesterol: 5, protein: 7 } },
  { id: '021', name: '해표콩기름', cls: 'ok', basis: 'per_100g',
    n: { calories: 900, sodium: 0, total_carbs: 0, total_sugars: 0, total_fat: 100, saturated_fat: 16, trans_fat: 0, cholesterol: 0, protein: 0 } },
  { id: '037', name: '칙촉', cls: 'ok', basis: 'per_total',
    n: { calories: 830, sodium: 620, total_carbs: 102, total_sugars: 51, total_fat: 42, saturated_fat: 24, trans_fat: 0.5, cholesterol: 65, protein: 11.3 } },

  { id: '008', name: '맥심모카골드', cls: 'scatter', basis: 'per_serving',
    note: 'Vision 이 값 열과 라벨 열을 따로 낸다: "나트륨 ⏎ 당류 ⏎ … ⏎ 6mg 0% 탄수화물 9g 3% ⏎ 6g 6% 지방 1.6g 3%". ⚠ truth 정정(세션68): v1(쿠팡 캡처 정제본)은 지방 1g 2% 인데 이 사진의 Vision 원문은 "1.6g 3%" 이고 3%×54g=1.62 로 값·% 두 독립 판독이 일치한다 ⇒ 이 사진의 포장은 1.6g 이다(다른 판 포장). 사진이 정본이므로 1.6 으로 둔다.',
    n: { calories: 50, sodium: 6, total_carbs: 9, total_sugars: 6, total_fat: 1.6, saturated_fat: 1.6, trans_fat: 0, cholesterol: 0, protein: 0 } },
  { id: '018', name: '(트러플 시즈닝 과자)', cls: 'scatter',
    note: '2열 인터리브: "나트륨 ⏎ 지방 ⏎ 690 mg ⏎ 28g ⏎ 35%". 열량 줄이 사진에 없다 → calories null.',
    n: { calories: null, sodium: 690, total_carbs: 60.5, total_sugars: 1, total_fat: 28, saturated_fat: 11, trans_fat: 0, cholesterol: 0, protein: 8.6 } },
  { id: '030', name: '다향훈제오리', cls: 'g9', basis: 'per_100g',
    note: '"탄수화물 29." = 2g (1%) · "포화지방 48g" = 4.8g (32%). 4-9-4: 19×9+13×4+2×4=231 ✓',
    n: { calories: 231, sodium: 737, total_carbs: 2, total_sugars: 1, total_fat: 19, saturated_fat: 4.8, trans_fat: 0, cholesterol: 85, protein: 13 },
    forbid: { total_carbs: [29], saturated_fat: [48] } },
  { id: '034', name: '(삭카린 감미료)', cls: 'absent', empty: true, note: '사진에 영양표가 없다. 정답은 «아무 값도 안 내는 것».' },
  { id: '036', name: '첵스초코', cls: 'decimal', basis: 'per_100g',
    note: '"당류 249"=24g · "지방 42g 8%"=4.2g · "포화지방 1.99"=1.9g. 4-9-4: 82×4+7×4+4.2×9=393.8 ✓ 394',
    n: { calories: 394, sodium: 450, total_carbs: 82, total_sugars: 24, total_fat: 4.2, saturated_fat: 1.9, trans_fat: 0, cholesterol: 0, protein: 7 },
    forbid: { total_sugars: [249], total_fat: [42], saturated_fat: [1.99, 199] } },
  { id: '039', name: '(품목보고번호만)', cls: 'absent', empty: true },
  { id: '040', name: '(사골라면 5봉)', cls: 'glued', basis: 'per_serving',
    note: '"단백질 9 16%" 단위 없음 → 9g. "포화지방 15%" 값 자체가 없음 → null. 4-9-4: 65×4+9×4+6×9=350 ✓. ⚠ 나트륨은 «미채점»: 원문 "1,700 mg 90%" 인데 90%×2000=1800 이라 값·% 가 어긋난다 — 어느 쪽이 오독인지 사진 없이 판정 불가. truth 에서 뺀다(추정 금지).',
    n: { calories: 350, total_carbs: 65, total_sugars: 5, total_fat: 6, saturated_fat: null, trans_fat: 0, cholesterol: 0, protein: 9 },
    forbid: { saturated_fat: [15] } },
  { id: '046', name: '(총 내용량당 342g)', cls: 'label_incons',
    note: '라벨 자체가 모순: 탄수 23.2g·지방 0g 인데 "100g당 305 kcal". 파서가 고칠 문제가 아니다 — 검산 경고(U67-12)가 «떠야» 한다.',
    n: { calories: 305, sodium: 720, total_carbs: 23.2, total_sugars: 4, total_fat: 0, saturated_fat: 0, trans_fat: 0, cholesterol: 0, protein: 1.2 },
    expect_calorie_mismatch: true },
  { id: '048', name: '칼집돼지왕구이', cls: 'g9', basis: 'per_100g',
    note: '"2000g당 185 kcal" 은 100g당(1kg=1,850kcal 로 확인). "포화지방 449 29%"=4.4g. 4-9-4: 11×4+11×4+11×9=187 ✓',
    n: { calories: 185, sodium: 420, total_carbs: 11, total_sugars: 7, total_fat: 11, saturated_fat: 4.4, trans_fat: 0, cholesterol: 35, protein: 11 },
    forbid: { saturated_fat: [449], calories: [1850] } },
  { id: '059', name: '포스트 아몬드', cls: '2col', basis: 'per_serving',
    note: '우유 포함 열(76g·27g·11g·6g)이 옆에 있다. 1회(30g) 열만 정답. 4-9-4: 23×4+2×4+3.2×9=128.8 ✓',
    n: { calories: 129, sodium: 100, total_carbs: 23, total_sugars: 8, total_fat: 3.2, saturated_fat: 1.1, trans_fat: 0, cholesterol: 0, protein: 2 },
    forbid: { total_carbs: [76], total_sugars: [27], total_fat: [11], protein: [6], saturated_fat: [3.6] } },
  { id: '060', name: '(면 3kg)', cls: 'g9', basis: 'per_100g',
    note: '"단백질 99"=9g (16% ✓). 4-9-4: 69×4+9×4+3×9=339 ✓',
    n: { calories: 340, sodium: 1530, total_carbs: 69, total_sugars: 7, total_fat: 3, saturated_fat: 1, trans_fat: 0, cholesterol: 0, protein: 9 },
    forbid: { protein: [99] } },
  { id: '063', name: '(음료 제조원 면)', cls: 'absent', empty: true },
  { id: '072', name: '메가도스C', cls: 'absent', empty: true,
    note: '건강기능식품 «영양·기능정보» 면. 영양표가 아니다 — 파서가 열량 10 등을 만들어 내면 오답.' },
  { id: '074', name: '(음료 190ml)', cls: 'partial_label', basis: 'per_total',
    note: '라벨이 열량·나트륨·탄수·당류만 표기. 나머지 null 이 정답(«없음»을 0 으로 채우면 오답).',
    n: { calories: 85, sodium: 5, total_carbs: 21, total_sugars: 20, total_fat: null, saturated_fat: null, trans_fat: null, cholesterol: null, protein: null } },
  { id: '077', name: '삼양1963', cls: 'glued', basis: 'per_serving',
    note: '"1봉지(13530 kcal" = 1봉지(131g)당 530kcal. 4-9-4: 80×4+10×4+19×9=531 ✓',
    n: { calories: 530, sodium: 1740, total_carbs: 80, total_sugars: 3, total_fat: 19, saturated_fat: 7, trans_fat: 0.6, cholesterol: 10, protein: 10 },
    forbid: { calories: [13530] } },
  { id: '080', name: '볶음참깨', cls: 'absent', empty: true },
  { id: '088', name: '(음료 190ml 0kcal)', cls: 'glued', basis: 'per_total',
    note: '"열량 OKcal" — 영문 O. 0 이 정답.',
    n: { calories: 0, sodium: 15, total_carbs: 0, total_sugars: 0, total_fat: 0, saturated_fat: 0, trans_fat: 0, cholesterol: 0, protein: 0 } },
  { id: '092', name: '유기농 레몬쥬스', cls: 'decimal',
    note: '"지방 20g 4%" = 2g (4% ✓ · 4-9-4: 66×4+4×4+2×9=298 ✓ 정확히 일치). 기준(500ml/1병)은 미확정 → basis 미채점.',
    n: { calories: 298, sodium: 0, total_carbs: 66, total_sugars: 20, total_fat: 2, saturated_fat: 0, trans_fat: 0, cholesterol: 0, protein: 4 },
    forbid: { total_fat: [20] } },
];

const lines = CASES.map((c) => JSON.stringify({
  id: c.id + '_' + c.name,
  source: '.tmp/s60/vision/raw/' + c.id + '.json.gz (Google Vision fullTextAnnotation.text)',
  class: c.cls,
  note: c.note || null,
  truth: {
    empty: !!c.empty,
    basis: c.basis || null,
    nutrition: c.n || null,
    forbid: c.forbid || null,
    expect_calorie_mismatch: !!c.expect_calorie_mismatch,
  },
  text: visionText(c.id),
}));

const body = lines.join('\n') + '\n';
fs.mkdirSync(path.dirname(OUT_CANON), { recursive: true });
fs.writeFileSync(OUT_CANON, body);
fs.mkdirSync(path.dirname(OUT_REPO), { recursive: true });
fs.writeFileSync(OUT_REPO, body);
console.log(`wrote ${CASES.length} cases →\n  ${OUT_CANON}\n  ${OUT_REPO}`);
