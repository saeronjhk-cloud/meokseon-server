-- ============================================================
-- 먹선(吃選) 초기 Config 씨드 데이터
-- 영양 신호등 v1.3 기준값 + OCR Sanity Check + 건조식품 키워드
-- ============================================================

-- ============================================================
-- 1. 1일 영양성분 기준치 (Daily Value) — 식약처 별표5
-- ============================================================

INSERT INTO nutrition_config (nutrient, threshold, basis, value, unit, profile, effective_from, source) VALUES
-- DV 기준치
('calories',    'dv', 'absolute', 2000,   'kcal', 'adult', '2020-09-09', '식약처 별표5'),
('total_fat',   'dv', 'absolute', 54,     'g',    'adult', '2020-09-09', '식약처 별표5'),
('sat_fat',     'dv', 'absolute', 15,     'g',    'adult', '2020-09-09', '식약처 별표5'),
('cholesterol', 'dv', 'absolute', 300,    'mg',   'adult', '2020-09-09', '식약처 별표5'),
('sodium',      'dv', 'absolute', 2000,   'mg',   'adult', '2020-09-09', '식약처 별표5'),
('total_carbs', 'dv', 'absolute', 324,    'g',    'adult', '2020-09-09', '식약처 별표5'),
('sugars',      'dv', 'absolute', 100,    'g',    'adult', '2020-09-09', '식약처 별표5'),
('fiber',       'dv', 'absolute', 25,     'g',    'adult', '2020-09-09', '식약처 별표5'),
('protein',     'dv', 'absolute', 55,     'g',    'adult', '2020-09-09', '식약처 별표5');

-- ============================================================
-- 2. 제한 영양성분 — %DV 기준 신호등 컷오프
-- ============================================================

-- 나트륨 %DV
INSERT INTO nutrition_config (nutrient, threshold, basis, value, unit, profile, effective_from, source) VALUES
('sodium', 'green_max',  'pct_dv', 10,  '%', 'adult', '2026-04-21', '영양 신호등 v1.3'),
('sodium', 'yellow_max', 'pct_dv', 25,  '%', 'adult', '2026-04-21', '영양 신호등 v1.3'),

-- 당류 %DV
('sugars', 'green_max',  'pct_dv', 10,  '%', 'adult', '2026-04-21', '영양 신호등 v1.3'),
('sugars', 'yellow_max', 'pct_dv', 25,  '%', 'adult', '2026-04-21', '영양 신호등 v1.3'),

-- 포화지방 %DV
('sat_fat', 'green_max',  'pct_dv', 10, '%', 'adult', '2026-04-21', '영양 신호등 v1.3'),
('sat_fat', 'yellow_max', 'pct_dv', 25, '%', 'adult', '2026-04-21', '영양 신호등 v1.3'),

-- 지방(총) %DV
('total_fat', 'green_max',  'pct_dv', 10, '%', 'adult', '2026-04-21', '영양 신호등 v1.3'),
('total_fat', 'yellow_max', 'pct_dv', 25, '%', 'adult', '2026-04-21', '영양 신호등 v1.3'),

-- 콜레스테롤 %DV (100g 기준 없음)
('cholesterol', 'green_max',  'pct_dv', 10, '%', 'adult', '2026-04-21', '영양 신호등 v1.3'),
('cholesterol', 'yellow_max', 'pct_dv', 25, '%', 'adult', '2026-04-21', '영양 신호등 v1.3');

-- ============================================================
-- 3. 제한 영양성분 — 100g당 절대량 기준 (FSA 참조)
-- ============================================================

INSERT INTO nutrition_config (nutrient, threshold, basis, value, unit, profile, effective_from, source) VALUES
-- 나트륨 /100g
('sodium', 'green_max',  'per_100g', 120,  'mg', 'adult', '2026-04-21', 'UK FSA + 한국 보정'),
('sodium', 'yellow_max', 'per_100g', 600,  'mg', 'adult', '2026-04-21', 'UK FSA + 한국 보정'),

-- 당류 /100g
('sugars', 'green_max',  'per_100g', 5,    'g',  'adult', '2026-04-21', 'UK FSA + WHO'),
('sugars', 'yellow_max', 'per_100g', 15,   'g',  'adult', '2026-04-21', 'UK FSA + WHO'),

-- 포화지방 /100g
('sat_fat', 'green_max',  'per_100g', 1.5, 'g',  'adult', '2026-04-21', 'UK FSA'),
('sat_fat', 'yellow_max', 'per_100g', 5,   'g',  'adult', '2026-04-21', 'UK FSA'),

-- 지방(총) /100g
('total_fat', 'green_max',  'per_100g', 3,    'g', 'adult', '2026-04-21', 'UK FSA'),
('total_fat', 'yellow_max', 'per_100g', 17.5, 'g', 'adult', '2026-04-21', 'UK FSA');

-- ============================================================
-- 4. 음료 기준 — 100mL당 절대량
-- ============================================================

INSERT INTO nutrition_config (nutrient, threshold, basis, value, unit, profile, effective_from, source) VALUES
-- 나트륨 /100mL
('sodium', 'green_max',  'per_100ml', 50,   'mg', 'adult', '2026-04-21', '영양 신호등 v1.3'),
('sodium', 'yellow_max', 'per_100ml', 250,  'mg', 'adult', '2026-04-21', '영양 신호등 v1.3'),

-- 당류 /100mL
('sugars', 'green_max',  'per_100ml', 2.5,  'g',  'adult', '2026-04-21', '영양 신호등 v1.3'),
('sugars', 'yellow_max', 'per_100ml', 6.3,  'g',  'adult', '2026-04-21', '영양 신호등 v1.3'),

-- 포화지방 /100mL
('sat_fat', 'green_max',  'per_100ml', 0.75, 'g', 'adult', '2026-04-21', '영양 신호등 v1.3'),
('sat_fat', 'yellow_max', 'per_100ml', 2.5,  'g', 'adult', '2026-04-21', '영양 신호등 v1.3'),

-- 지방(총) /100mL
('total_fat', 'green_max',  'per_100ml', 1.5,  'g', 'adult', '2026-04-21', '영양 신호등 v1.3'),
('total_fat', 'yellow_max', 'per_100ml', 8.75, 'g', 'adult', '2026-04-21', '영양 신호등 v1.3');

-- ============================================================
-- 5. 권장 영양성분 — %DV 기준 (역방향: 많을수록 좋음)
-- ============================================================

INSERT INTO nutrition_config (nutrient, threshold, basis, value, unit, profile, effective_from, source, notes) VALUES
-- 단백질 (gray < 5%, yellow 5~15%, green ≥ 15%)
('protein', 'gray_max',   'pct_dv', 5,  '%', 'adult', '2026-04-21', '영양 신호등 v1.3', '5% 미만 → 회색 (적색 피로감 방지)'),
('protein', 'green_min',  'pct_dv', 15, '%', 'adult', '2026-04-21', '영양 신호등 v1.3', '15% 이상 → 초록 (풍부)'),

-- 식이섬유
('fiber', 'gray_max',   'pct_dv', 5,  '%', 'adult', '2026-04-21', '영양 신호등 v1.3', '5% 미만 → 회색 (적색 피로감 방지)'),
('fiber', 'green_min',  'pct_dv', 15, '%', 'adult', '2026-04-21', '영양 신호등 v1.3', '15% 이상 → 초록 (풍부)');

-- ============================================================
-- 6. 트랜스지방 특별 규칙 (DV 미설정)
-- ============================================================

INSERT INTO nutrition_config (nutrient, threshold, basis, value, unit, profile, effective_from, source) VALUES
('trans_fat', 'green_max',  'absolute', 0,   'g', 'adult', '2026-04-21', 'WHO 권고'),
('trans_fat', 'yellow_max', 'absolute', 0.5, 'g', 'adult', '2026-04-21', 'WHO 권고');

-- ============================================================
-- 7. 개인화 프로필별 DV (Phase 2 대비 사전 등록)
-- ============================================================

INSERT INTO nutrition_config (nutrient, threshold, basis, value, unit, profile, effective_from, source) VALUES
-- 임산부
('protein', 'dv', 'absolute', 65, 'g', 'pregnant', '2026-04-21', 'KDRI 2020 임신부'),
('sodium',  'dv', 'absolute', 2000, 'mg', 'pregnant', '2026-04-21', 'KDRI 2020'),

-- 영유아 (1~2세)
('sugars',  'dv', 'absolute', 50,  'g',  'infant', '2026-04-21', 'KDRI 2020 영유아'),
('sodium',  'dv', 'absolute', 700, 'mg', 'infant', '2026-04-21', 'KDRI 2020 영유아'),

-- 어린이 (3~11세)
('sugars',  'dv', 'absolute', 70,   'g',  'child', '2026-04-21', 'KDRI 2020 소아'),
('sodium',  'dv', 'absolute', 1500, 'mg', 'child', '2026-04-21', 'KDRI 2020 소아');

-- ============================================================
-- 8. 식품 카테고리별 맥락 안내 메시지
-- ============================================================

INSERT INTO context_messages (food_category, nutrient, message_ko, display_type) VALUES
('fermented', 'sodium',  '발효식품은 나트륨이 높으나, 유산균·식이섬유 등 건강 유익 성분이 함께 포함되어 있습니다.', 'tooltip'),
('sauce',     'sodium',  '양념류는 1회 사용량이 적으므로 실제 섭취 나트륨은 표시보다 낮을 수 있습니다.', 'tooltip'),
('nuts',      'total_fat', '지방 함량이 높지만, 불포화지방산이 풍부한 건강한 지방입니다.', 'tooltip'),
('dairy',     'sat_fat', '포화지방이 포함되어 있으나, 칼슘과 단백질의 주요 공급원입니다.', 'tooltip'),
('juice',     'sugars',  '천연 과당이 포함되어 당류가 높게 표시됩니다. 첨가당과 구분하세요.', 'tooltip'),
('whole_grain','total_carbs', '탄수화물이 높지만, 식이섬유와 미네랄이 풍부합니다.', 'tooltip'),
('alcohol',    NULL,     '주류는 영양 신호등 평가 대상이 아닙니다.', 'banner'),
('supplement', NULL,     '건강기능식품은 별도 기준이 적용됩니다.', 'banner'),
('raw_ingredient', NULL, '원료 식품은 영양성분표가 부착되지 않는 미가공 제품입니다.', 'banner'),
-- v1.2 추가: 국물류 맥락
('general',   'sodium',  '국물 요리의 표시 나트륨은 국물을 모두 마셨을 때 기준입니다. 국물을 적게 드시면 크게 줄일 수 있습니다.', 'tooltip');

-- ============================================================
-- 9. OCR Sanity Check 상한값
-- ============================================================

INSERT INTO ocr_sanity_limits (nutrient, per_serving_max, per_100g_max, unit, notes) VALUES
('calories',    2000,   900,    'kcal', '순수 지방(100g=900kcal)이 물리적 최대'),
('sodium',      5000,   40000,  'mg',   '순수 소금(100g=39,337mg Na)'),
('sugars',      200,    100,    'g',    '100g당 100g 초과 불가'),
('total_fat',   200,    100,    'g',    '100g당 100g 초과 불가'),
('sat_fat',     100,    100,    'g',    '지방 총량 초과 불가'),
('protein',     200,    100,    'g',    '100g당 100g 초과 불가'),
('cholesterol', 2000,   NULL,   'mg',   '뇌(100g당 ~2,000mg)가 최대치 식품'),
('trans_fat',   50,     100,    'g',    NULL),
('fiber',       100,    100,    'g',    '100g당 100g 초과 불가');

-- ============================================================
-- 10. 건조식품 키워드 사전
-- ============================================================

INSERT INTO dried_food_keywords (keyword, category_match, priority) VALUES
('육포',     'dried', 1),
('말린',     'dried', 1),
('건조',     'dried', 1),
('분말',     'dried', 1),
('김',       'dried', 2),
('가루',     'dried', 1),
('건과',     'dried', 1),
('건표고',   'dried', 1),
('무건량',   'dried', 1),
('누룽지',   'dried', 2),
('건포도',   'dried', 1),
('건새우',   'dried', 1),
('건어물',   'dried', 1),
('미역',     'dried', 2),
('다시마',   'dried', 2),
('고춧가루', 'dried', 1),
('고추장',   'dried', 2),
('된장',     'fermented', 2),
('간장',     'fermented', 2),
('김치',     'fermented', 2),
('젓갈',     'fermented', 2),
('청국장',   'fermented', 2);
