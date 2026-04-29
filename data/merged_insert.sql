-- 자동 생성된 공공데이터 INSERT문
-- 생성일: 2026-04-21T05:53:19.133Z

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801043012607', '새우깡', '(주)농심', '(주)농심', '과자', 30, 90, 'g', 'public_c005', 'R001', 'N001')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 140, 7, 1.5, 0, 5, 200, 18, 2, 0.5, 2, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801043032704', '신라면', '(주)농심', '(주)농심', '유탕면류', 120, 120, 'g', 'public_c005', 'R002', 'N002')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 500, 16, 7, 0, 0, 1790, 78, 4, 3, 10, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8806007045052', '코카콜라 제로', '한국코카콜라(주)', '한국코카콜라(주)', '탄산음료', 250, 500, 'ml', 'public_c005', 'R003', 'N003')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 0, 0, 0, 0, 0, 25, 0, 0, 0, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801115112006', '서울우유 1급A', '서울우유협동조합', '서울우유협동조합', '우유류', 200, 1000, 'ml', 'public_c005', 'R004', 'N004')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 130, 7, 4.5, 0.2, 25, 100, 10, 9, 0, 6, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801069123456', '풀무원 두부', '(주)풀무원', '(주)풀무원', '두부류', 100, 300, 'g', 'public_c005', 'R005', 'N005')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 84, 4.5, 0.7, 0, 0, 5, 2, 0.5, 0.3, 9, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801007654321', '비비고 왕교자', 'CJ제일제당(주)', 'CJ제일제당(주)', '만두류', 120, 350, 'g', 'public_c005', 'R006', 'N006')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 240, 8, 2.5, 0, 20, 480, 32, 3, 2, 9, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '참치캔(동원)', '동원F&B', '동원F&B', NULL, 100, NULL, NULL, 'public_nutrition', NULL, 'N007')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 180, 10, 2, 0, 45, 400, 0, 0, 0, 22, 'public_nutrition');
