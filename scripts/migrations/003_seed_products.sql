-- 자동 생성된 공공데이터 INSERT문
-- 생성일: 2026-04-21T21:15:43.636Z

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801043012607', '새우깡', NULL, '(주)농심', '과자', 'general', 30, 90, 'g', 'public_c005', 'R001', 'N001')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 140, 7, 1.5, 0, 5, 200, 18, 2, 0.5, 2, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801117211004', '포카칩 오리지널', NULL, '(주)오리온', '스낵', 'general', 30, 66, 'g', 'public_c005', 'R002', 'N002')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 160, 10, 3, 0, 0, 170, 17, 0.5, 1, 1.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801062634507', '칸쵸 초코', NULL, '롯데웰푸드(주)', '비스킷', 'general', 36, 72, 'g', 'public_c005', 'R004', 'N004')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 185, 9, 5, 0, 10, 110, 24, 12, 0.5, 2.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801019303401', '오예스', NULL, '해태제과식품(주)', '케이크', 'general', 30, 360, 'g', 'public_c005', 'R005', 'N005')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 130, 6, 3.5, 0, 15, 75, 19, 12, 0.3, 1.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801062027507', '빼빼로 초코', NULL, '롯데웰푸드(주)', '비스킷', 'general', 27, 54, 'g', 'public_c005', 'R006', 'N006')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 140, 7, 4, 0, 5, 65, 18, 11, 0.5, 2, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801037062908', '프링글스 오리지널', NULL, '켈로그(주)', '감자칩', 'general', 25, 110, 'g', 'public_c005', 'R007', 'N007')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 135, 8.5, 2.5, 0, 0, 135, 14, 0.5, 0.8, 1, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801019607806', '허니버터칩', NULL, '해태제과식품(주)', '스낵', 'general', 30, 60, 'g', 'public_c005', 'R008', 'N008')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 160, 9, 3, 0, 0, 130, 19, 5, 0.5, 1.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801117779603', '고래밥 볶음양념맛', NULL, '(주)오리온', '스낵', 'general', 40, 40, 'g', 'public_c005', 'R009', 'N009')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 180, 6, 2.5, 0, 10, 280, 29, 5, 0.5, 3, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801043013000', '양파링', NULL, '(주)농심', '스낵', 'general', 30, 84, 'g', 'public_c005', 'R010', 'N010')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 150, 8, 3.5, 0, 0, 210, 19, 3, 0.3, 1.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801117100100', '초코파이', NULL, '(주)오리온', '파이', 'general', 35, 420, 'g', 'public_c005', 'R011', 'N011')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 150, 6, 3, 0, 10, 100, 23, 15, 0.5, 2, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801062001200', '마가렛트', NULL, '롯데웰푸드(주)', '쿠키', 'general', 22, 176, 'g', 'public_c005', 'R012', 'N012')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 105, 5, 2.5, 0, 10, 65, 14, 6, 0.2, 1.2, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801043032704', '신라면', NULL, '(주)농심', '유탕면류', 'general', 120, 120, 'g', 'public_c005', 'R013', 'N013')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 500, 16, 7, 0, 0, 1790, 78, 4, 3, 10, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801045520001', '진라면 순한맛', NULL, '(주)오뚜기', '유탕면류', 'general', 120, 120, 'g', 'public_c005', 'R014', 'N014')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 485, 16, 7, 0, 0, 1550, 75, 5, 2, 9, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801043032902', '너구리', NULL, '(주)농심', '유탕면류', 'general', 120, 120, 'g', 'public_c005', 'R015', 'N015')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 490, 15, 6.5, 0, 0, 1630, 79, 5, 2, 9, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801043033008', '짜파게티', NULL, '(주)농심', '유탕면류', 'general', 140, 140, 'g', 'public_c005', 'R016', 'N016')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 590, 21, 9, 0, 0, 1360, 89, 5, 2.5, 10, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801073100107', '삼양라면', NULL, '삼양식품(주)', '유탕면류', 'general', 120, 120, 'g', 'public_c005', 'R017', 'N017')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 490, 16, 7, 0, 0, 1520, 76, 3, 2, 9, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801073110809', '불닭볶음면', NULL, '삼양식품(주)', '유탕면류', 'general', 140, 140, 'g', 'public_c005', 'R018', 'N018')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 530, 16, 7.5, 0, 0, 1830, 87, 7, 2, 9, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801043032711', '신라면 컵', NULL, '(주)농심', '유탕면류', 'general', 65, 65, 'g', 'public_c005', 'R019', 'N019')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 280, 10, 3.5, 0, 0, 1600, 42, 4, 2, 6, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801043036306', '컵누들 매콤한맛', NULL, '(주)농심', '면류', 'general', 37.5, 37.5, 'g', 'public_c005', 'R020', 'N020')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 165, 7, 3, 0, 10, 720, 21, 2, 1, 4, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801043032308', '안성탕면', NULL, '(주)농심', '유탕면류', 'general', 125, 125, 'g', 'public_c005', 'R021', 'N021')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 520, 18, 8, 0, 0, 1680, 78, 6, 2.5, 10, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8803900020101', '비빔면', NULL, '팔도(주)', '유탕면류', 'general', 130, 130, 'g', 'public_c005', 'R022', 'N022')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 490, 14, 6, 0, 0, 1170, 81, 14, 2, 9, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8806007045052', '코카콜라 제로', NULL, '한국코카콜라(주)', '탄산음료', 'beverage', 250, 500, 'ml', 'public_c005', 'R023', 'N023')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 0, 0, 0, 0, 0, 25, 0, 0, 0, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801056037802', '펩시콜라', NULL, '롯데칠성음료(주)', '탄산음료', 'beverage', 250, 500, 'ml', 'public_c005', 'R024', 'N024')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 115, 0, 0, 0, 0, 20, 29, 28, 0, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801056099009', '델몬트 오렌지주스 100%', NULL, '롯데칠성음료(주)', '과채주스', 'beverage', 200, 1000, 'ml', 'public_c005', 'R025', 'N025')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 88, 0, 0, 0, 0, 10, 21, 18, 0.5, 1, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801037010008', '포카리스웨트', NULL, '동아오츠카(주)', '음료류', 'beverage', 250, 500, 'ml', 'public_c005', 'R027', 'N027')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 63, 0, 0, 0, 0, 123, 15.5, 14, 0, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801045050003', '비타500', NULL, '광동제약(주)', '음료류', 'beverage', 100, 100, 'ml', 'public_c005', 'R028', 'N028')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 45, 0, 0, 0, 0, 10, 11, 10, 0, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801037070002', '아메리카노 T.O.P', NULL, '동서식품(주)', '커피음료', 'beverage', 275, 275, 'ml', 'public_c005', 'R031', 'N031')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 15, 0, 0, 0, 0, 55, 3, 2, 0, 0.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801037080001', '맥스웰하우스 T.O.P 스위트아메리카노', NULL, '동서식품(주)', '커피음료', 'beverage', 275, 275, 'ml', 'public_c005', 'R032', 'N032')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 60, 0.5, 0.3, 0, 0, 60, 13, 12, 0, 1, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801056090006', '칸타타 콘트라베이스', NULL, '롯데칠성음료(주)', '커피음료', 'beverage', 275, 500, 'ml', 'public_c005', 'R033', 'N033')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 35, 0.5, 0.3, 0, 0, 60, 7, 6, 0, 1, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801007100005', '헛개수', NULL, 'CJ제일제당(주)', '음료류', 'beverage', 250, 500, 'ml', 'public_c005', 'R034', 'N034')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 0, 0, 0, 0, 0, 30, 0, 0, 0, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801045060002', '옥수수수염차', NULL, '광동제약(주)', '음료류', 'beverage', 250, 500, 'ml', 'public_c005', 'R035', 'N035')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 0, 0, 0, 0, 0, 25, 0, 0, 0, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801120170004', '매일 바나나우유', NULL, '매일유업(주)', '가공유류', 'beverage', 200, 200, 'ml', 'public_c005', 'R036', 'N036')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 170, 3.5, 2, 0, 15, 115, 30, 27, 0, 5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801104200004', '빙그레 바나나맛우유', NULL, '빙그레(주)', '가공유류', 'beverage', 240, 240, 'ml', 'public_c005', 'R037', 'N037')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 220, 5, 3.5, 0, 20, 140, 37, 34, 0, 6, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801115112006', '서울우유 1급A', NULL, '서울우유협동조합', '우유류', 'beverage', 200, 1000, 'ml', 'public_c005', 'R038', 'N038')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 130, 7, 4.5, 0.2, 25, 100, 10, 9, 0, 6, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801120310001', '매일 저지방우유', NULL, '매일유업(주)', '우유류', 'beverage', 200, 1000, 'ml', 'public_c005', 'R039', 'N039')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 80, 2, 1.2, 0, 10, 100, 10, 9, 0, 6.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801047300001', '덴마크 드링킹요거트 딸기', NULL, '동원F&B(주)', '발효유류', 'fermented', 150, 150, 'ml', 'public_c005', 'R043', 'N043')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 120, 1.5, 1, 0, 5, 60, 23, 20, 0, 3.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801120890003', '매일 상하목장 유기농우유', NULL, '매일유업(주)', '우유류', 'beverage', 200, 900, 'ml', 'public_c005', 'R044', 'N044')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 130, 7, 4.5, 0, 25, 95, 9, 9, 0, 6, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801104880002', '빙그레 끼리 크림치즈', NULL, '빙그레(주)', '치즈류', 'general', 18, 200, 'g', 'public_c005', 'R045', 'N045')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 52, 5, 3.3, 0, 15, 55, 0.7, 0.5, 0, 1, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801052720005', '종가 맛김치', NULL, '(주)대상', '김치류', 'fermented', 40, 500, 'g', 'public_c005', 'R046', 'N046')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 15, 0.3, 0, 0, 0, 340, 2.5, 1, 1.5, 1.2, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801007150000', '해찬들 태양초 고추장', NULL, 'CJ제일제당(주)', '장류', 'fermented', 15, 500, 'g', 'public_c005', 'R047', 'N047')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 30, 0.3, 0, 0, 0, 310, 6, 3.5, 0.5, 1, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801005001007', '샘표 양조간장 501', NULL, '샘표식품(주)', '장류', 'fermented', 15, 500, 'ml', 'public_c005', 'R048', 'N048')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 12, 0, 0, 0, 0, 920, 1.5, 0.5, 0, 1.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801052440002', '청정원 순창 된장', NULL, '(주)대상', '장류', 'fermented', 15, 500, 'g', 'public_c005', 'R049', 'N049')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 25, 0.7, 0.1, 0, 0, 720, 2.5, 0.5, 1, 2, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801069770005', '풀무원 깍두기', NULL, '(주)풀무원', '김치류', 'fermented', 40, 500, 'g', 'public_c005', 'R050', 'N050')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 12, 0.2, 0, 0, 0, 280, 2, 1, 1.2, 0.8, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801007660003', '비비고 열무김치', NULL, 'CJ제일제당(주)', '김치류', 'fermented', 40, 500, 'g', 'public_c005', 'R051', 'N051')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 10, 0.2, 0, 0, 0, 250, 1.8, 0.8, 1, 0.7, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801047200004', '동원 양반김 도시락김', NULL, '동원F&B(주)', '김류', 'dried', 5, 25, 'g', 'public_c005', 'R053', 'N053')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 25, 1.8, 0.3, 0, 0, 55, 0.5, 0, 0.5, 1.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8809045000002', '건조 망고', NULL, '(주)길림양행', '건과류', 'dried', 30, 100, 'g', 'public_c005', 'R054', 'N054')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 95, 0.2, 0, 0, 0, 10, 23, 20, 1.5, 0.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801045090009', '오뚜기 카레 분말', NULL, '(주)오뚜기', '분말식품', 'dried', 20, 100, 'g', 'public_c005', 'R057', 'N057')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 75, 3, 1.5, 0, 0, 650, 11, 2, 1, 1.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801007654321', '비비고 왕교자', NULL, 'CJ제일제당(주)', '만두류', 'general', 120, 350, 'g', 'public_c005', 'R058', 'N058')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 240, 8, 2.5, 0, 20, 480, 32, 3, 2, 9, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801069880001', '풀무원 얇은피 꽃만두', NULL, '(주)풀무원', '만두류', 'general', 120, 420, 'g', 'public_c005', 'R059', 'N059')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 235, 7, 2, 0, 15, 450, 33, 2.5, 2, 10, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801045530000', '오뚜기 3분 카레', NULL, '(주)오뚜기', '레토르트식품', 'general', 200, 200, 'g', 'public_c005', 'R060', 'N068')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 18, 0, 0, 0, 0, 170, 4.5, 3.5, 0, 0.2, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801007200003', 'CJ 햇반 백미', NULL, 'CJ제일제당(주)', '즉석밥', 'general', 210, 210, 'g', 'public_c005', 'R061', 'N061')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 315, 0.5, 0.1, 0, 0, 5, 71, 0, 1, 5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801047880001', '동원 리얼참치 김밥', NULL, '동원F&B(주)', '김밥', 'general', 230, 230, 'g', 'public_c005', 'R062', 'N062')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 380, 10, 2.5, 0, 25, 680, 60, 5, 2.5, 12, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801069990001', '풀무원 생면식감 냉면', NULL, '(주)풀무원', '면류', 'general', 462, 462, 'g', 'public_c005', 'R063', 'N063')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 450, 3, 1, 0, 30, 2100, 93, 10, 4, 13, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801045550008', '오뚜기 진짬뽕', NULL, '(주)오뚜기', '즉석조리식품', 'general', 230, 230, 'g', 'public_c005', 'R064', 'N102')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 75, 0.5, 0.1, 0, 20, 350, 13, 8, 0.5, 5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8809990000001', '교촌 허니콤보 치킨', NULL, '(주)교촌에프앤비', '즉석조리식품', 'general', 150, 350, 'g', 'public_c005', 'R065', 'N065')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 350, 18, 5, 0.3, 65, 720, 25, 10, 1, 20, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801007350002', 'CJ 고메 크로크무슈', NULL, 'CJ제일제당(주)', '즉석조리식품', 'general', 100, 200, 'g', 'public_c005', 'R066', 'N066')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 260, 14, 7, 0.2, 35, 550, 23, 3, 1, 10, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801045570006', '오뚜기 냉동 볶음밥', NULL, '(주)오뚜기', '즉석조리식품', 'general', 300, 450, 'g', 'public_c005', 'R067', 'N067')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 470, 10, 3, 0, 30, 950, 83, 4, 2, 10, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801045500008', '오뚜기 토마토 케첩', NULL, '(주)오뚜기', '소스류', 'general', 15, 300, 'g', 'public_c005', 'R068', 'N070')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 85, 9, 1.5, 0, 10, 95, 0.5, 0.3, 0, 0.2, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801052600000', '청정원 카놀라유', NULL, '(주)대상', '유지류', 'general', 15, 900, 'ml', 'public_c005', 'R069', 'N069')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 120, 14, 1, 0, 0, 0, 0, 0, 0, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801007400004', '백설 올리고당', NULL, 'CJ제일제당(주)', '당류가공품', 'general', 15, 700, 'g', 'public_c005', 'R072', 'N072')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 40, 0, 0, 0, 0, 15, 10, 3, 2.5, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801052700008', '청정원 스리라차 소스', NULL, '(주)대상', '소스류', 'general', 10, 215, 'ml', 'public_c005', 'R073', 'N073')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 10, 0, 0, 0, 0, 180, 2, 1.5, 0, 0.2, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801068300002', '삼립 미니꿀호떡', NULL, 'SPC삼립(주)', '빵류', 'general', 30, 192, 'g', 'public_c005', 'R074', 'N074')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 100, 2.5, 1, 0, 5, 110, 18, 8, 0.3, 1.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8809990100002', '파리바게뜨 모닝롤', NULL, '(주)파리크라상', '빵류', 'general', 35, 280, 'g', 'public_c005', 'R075', 'N075')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 115, 3.5, 1.5, 0, 10, 150, 18, 5, 0.5, 3, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801068400000', '삼립 크림빵', NULL, 'SPC삼립(주)', '빵류', 'general', 90, 90, 'g', 'public_c005', 'R076', 'N076')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 285, 10, 4, 0.1, 40, 230, 42, 20, 1, 6, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801043020008', '농심 바나나킥', NULL, '(주)농심', '스낵', 'general', 27, 75, 'g', 'public_c005', 'R079', 'N079')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 120, 4, 2, 0, 0, 85, 20, 7, 0.3, 1, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8809015930001', '정관장 홍삼정 에브리타임', NULL, '(주)KGC인삼공사', '건강기능식품', 'supplement', 10, 300, 'ml', 'public_c005', 'R082', 'N082')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 12, 0, 0, 0, 0, 5, 3, 0, 0, 0.1, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8809260000002', '종근당 비타민C 1000', NULL, '(주)종근당건강', '건강기능식품', 'supplement', 1, 60, 'g', 'public_c005', 'R083', 'N083')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 4, 0, 0, 0, 0, 0, 1, 0, 0, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8809370000001', '뉴트리원 유산균', NULL, '(주)뉴트리원', '건강기능식품', 'supplement', 2, 60, 'g', 'public_c005', 'R084', 'N084')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 5, 0, 0, 0, 0, 0, 1, 0, 0, 0.2, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801055600001', '참이슬', NULL, '하이트진로(주)', '소주', 'alcohol', 50, 360, 'ml', 'public_c005', 'R085', 'N085')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801069800002', '카스 프레시', NULL, '오비맥주(주)', '맥주', 'alcohol', 355, 355, 'ml', 'public_c005', 'R086', 'N086')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 150, 0, 0, 0, 0, 10, 10, 0, 0, 1, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801056200009', '처음처럼', NULL, '롯데칠성음료(주)', '소주', 'alcohol', 50, 360, 'ml', 'public_c005', 'R087', 'N087')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801152100003', '목우촌 뚝심 소시지', NULL, '(주)목우촌', '소시지류', 'general', 60, 300, 'g', 'public_c005', 'R091', 'N091')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 170, 14, 5, 0.2, 35, 520, 3, 1, 0, 8, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801047500001', '동원 리얼 햄', NULL, '동원F&B(주)', '햄류', 'general', 30, 200, 'g', 'public_c005', 'R093', 'N101')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 105, 5.5, 1.2, 0, 20, 280, 2, 1, 0, 12, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801492300001', '하림 더미식 닭가슴살', NULL, '(주)하림', '즉석조리식품', 'general', 100, 100, 'g', 'public_c005', 'R094', 'N094')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 110, 1.5, 0.5, 0, 60, 450, 1, 0, 0, 23, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801069123456', '풀무원 국산콩 두부', NULL, '(주)풀무원', '두부류', 'general', 100, 300, 'g', 'public_c005', 'R099', 'N099')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 84, 4.5, 0.7, 0, 0, 5, 2, 0.5, 0.3, 9, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801026600001', '삼육 검은콩 두유', NULL, '삼육식품(주)', '두유류', 'beverage', 190, 190, 'ml', 'public_c005', 'R100', 'N100')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 130, 4, 0.7, 0, 0, 105, 17, 10, 1, 6, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801062333806', '꼬깔콘 고소한맛', NULL, '롯데웰푸드(주)', '스낵', 'general', 30, 72, 'g', 'public_c005', 'R003', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8809254990002', '제주 삼다수', NULL, '제주특별자치도개발공사', '먹는샘물', 'beverage', 500, 500, 'ml', 'public_c005', 'R026', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801056020507', '밀키스', NULL, '롯데칠성음료(주)', '탄산음료', 'beverage', 250, 250, 'ml', 'public_c005', 'R029', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8806007019053', '토레타', NULL, '한국코카콜라(주)', '음료류', 'beverage', 240, 240, 'ml', 'public_c005', 'R030', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801007330002', '비요뜨 딸기', NULL, 'CJ제일제당(주)', '발효유류', 'fermented', 143, 143, 'g', 'public_c005', 'R040', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801069450003', '액티비아 플레인', NULL, '풀무원다논(주)', '발효유류', 'fermented', 80, 80, 'g', 'public_c005', 'R041', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801115550004', '서울우유 체다 슬라이스치즈', NULL, '서울우유협동조합', '치즈류', 'beverage', 18, 270, 'g', 'public_c005', 'R042', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801068100001', '쇠고기 육포', NULL, '(주)사조대림', '육포', 'dried', 25, 50, 'g', 'public_c005', 'R052', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801052200002', '대상 미원', NULL, '(주)대상', '조미료', 'general', 1, 100, 'g', 'public_c005', 'R055', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801007170008', 'CJ 다시다', NULL, 'CJ제일제당(주)', '조미료', 'general', 3, 100, 'g', 'public_c005', 'R056', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801045510007', '오뚜기 마요네즈', NULL, '(주)오뚜기', '소스류', 'general', 13, 300, 'g', 'public_c005', 'R070', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801005010009', '샘표 맛간장', NULL, '샘표식품(주)', '장류', 'fermented', 15, 500, 'ml', 'public_c005', 'R071', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801062200702', '롯데 빈츠', NULL, '롯데웰푸드(주)', '비스킷', 'general', 28, 102, 'g', 'public_c005', 'R077', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801019200007', '해태 에이스', NULL, '해태제과식품(주)', '크래커', 'general', 28, 218, 'g', 'public_c005', 'R078', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801062300005', '롯데 몽쉘', NULL, '롯데웰푸드(주)', '케이크', 'general', 32, 384, 'g', 'public_c005', 'R080', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801019400002', '해태 자유시간', NULL, '해태제과식품(주)', '초콜릿', 'general', 35, 70, 'g', 'public_c005', 'R081', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801007500001', '엑스트라 버진 올리브유', NULL, 'CJ제일제당(주)', '유지류', 'general', 15, 500, 'ml', 'public_c005', 'R088', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801045520009', '오뚜기 참기름', NULL, '(주)오뚜기', '식용유지', 'general', 15, 320, 'ml', 'public_c005', 'R089', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801007600006', '백설 포도씨유', NULL, 'CJ제일제당(주)', '유지류', 'general', 15, 900, 'ml', 'public_c005', 'R090', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801007700005', 'CJ 맥스봉', NULL, 'CJ제일제당(주)', '소시지류', 'general', 27, 270, 'g', 'public_c005', 'R092', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801068500002', '사조 런천미트', NULL, '(주)사조대림', '캔햄', 'general', 60, 340, 'g', 'public_c005', 'R095', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801047100008', '동원 참치 라이트스탠다드', NULL, '동원F&B(주)', '참치캔', 'general', 60, 150, 'g', 'public_c005', 'R096', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801068600000', '사조 어묵바', NULL, '(주)사조대림', '어묵류', 'general', 70, 200, 'g', 'public_c005', 'R097', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES ('8801045600001', '오뚜기 참치 마요', NULL, '(주)오뚜기', '참치캔', 'general', 50, 100, 'g', 'public_c005', 'R098', NULL)
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '꼬깔콘', NULL, '롯데제과', NULL, 'general', 30, NULL, NULL, 'public_nutrition', NULL, 'N003')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 160, 9, 4, 0, 0, 190, 19, 3, 0, 1.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '제주삼다수(먹는샘물)', NULL, '제주도개발공사', NULL, 'general', 500, NULL, NULL, 'public_nutrition', NULL, 'N026')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 0, 0, 0, 0, 0, 3.6, 0, 0, 0, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '밀키스(유성탄산)', NULL, '롯데칠성', NULL, 'general', 250, NULL, NULL, 'public_nutrition', NULL, 'N029')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 105, 0, 0, 0, 0, 30, 26, 23, 0, 0.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '토레타(이온음료)', NULL, '코카콜라', NULL, 'beverage', 240, NULL, NULL, 'public_nutrition', NULL, 'N030')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 53, 0, 0, 0, 0, 50, 13, 13, 0, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '비요뜨(발효유)', NULL, 'CJ', NULL, 'general', 143, NULL, NULL, 'public_nutrition', NULL, 'N040')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 185, 4, 2.5, 0, 10, 75, 33, 28, 0.5, 4, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '액티비아 요거트', NULL, '다논', NULL, 'general', 80, NULL, NULL, 'public_nutrition', NULL, 'N041')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 58, 1, 0.6, 0, 5, 40, 9.5, 7, 0, 3, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '체다슬라이스 치즈', NULL, '서울우유', NULL, 'general', 18, NULL, NULL, 'public_nutrition', NULL, 'N042')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 55, 4.5, 3, 0.1, 15, 230, 0.5, 0, 0, 3, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '쇠고기육포(간식)', NULL, '사조', NULL, 'dried', 25, NULL, NULL, 'public_nutrition', NULL, 'N052')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 80, 1.5, 0.5, 0, 20, 350, 2.5, 2, 0, 15, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '미원(MSG 조미료)', NULL, '대상', NULL, 'general', 1, NULL, NULL, 'public_nutrition', NULL, 'N055')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 0, 0, 0, 0, 0, 130, 0, 0, 0, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '다시다(조미료)', NULL, 'CJ', NULL, 'general', 3, NULL, NULL, 'public_nutrition', NULL, 'N056')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 5, 0, 0, 0, 0, 520, 0.8, 0.3, 0, 0.3, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '3분카레(레토르트)', NULL, '오뚜기', NULL, 'general', 200, NULL, NULL, 'public_nutrition', NULL, 'N060')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 175, 7, 3, 0, 15, 870, 23, 4, 2, 5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '진짬뽕(즉석)', NULL, '오뚜기', NULL, 'general', 230, NULL, NULL, 'public_nutrition', NULL, 'N064')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 200, 5, 2, 0, 20, 1350, 30, 4, 3, 8, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '맛간장(장류)', NULL, '샘표', NULL, 'fermented', 15, NULL, NULL, 'public_nutrition', NULL, 'N071')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 15, 0, 0, 0, 0, 850, 2.5, 1, 0, 1.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '빈츠(비스킷)', NULL, '롯데', NULL, 'general', 28, NULL, NULL, 'public_nutrition', NULL, 'N077')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 150, 8, 5, 0, 5, 80, 18, 9, 0.5, 2, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '에이스(크래커)', NULL, '해태', NULL, 'general', 28, NULL, NULL, 'public_nutrition', NULL, 'N078')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 130, 5, 2.5, 0, 0, 210, 19, 3, 0.5, 2.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '몽쉘(케이크)', NULL, '롯데', NULL, 'general', 32, NULL, NULL, 'public_nutrition', NULL, 'N080')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 145, 8, 5, 0, 15, 75, 17, 12, 0.3, 1.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '자유시간(초콜릿)', NULL, '해태', NULL, 'general', 35, NULL, NULL, 'public_nutrition', NULL, 'N081')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 195, 12, 7, 0, 5, 45, 20, 17, 1, 2.5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '올리브유(엑스트라버진)', NULL, 'CJ', NULL, 'general', 15, NULL, NULL, 'public_nutrition', NULL, 'N088')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 120, 14, 2, 0, 0, 0, 0, 0, 0, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '참기름(식용유지)', NULL, '오뚜기', NULL, 'general', 15, NULL, NULL, 'public_nutrition', NULL, 'N089')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 120, 14, 2.2, 0, 0, 0, 0, 0, 0, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '포도씨유(식용유지)', NULL, 'CJ', NULL, 'general', 15, NULL, NULL, 'public_nutrition', NULL, 'N090')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 120, 14, 1.5, 0, 0, 0, 0, 0, 0, 0, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '맥스봉(소시지)', NULL, 'CJ', NULL, 'general', 27, NULL, NULL, 'public_nutrition', NULL, 'N092')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 65, 5, 2, 0.1, 15, 210, 2, 1, 0, 3, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '리얼햄(햄류)', NULL, '동원', NULL, 'general', 30, NULL, NULL, 'public_nutrition', NULL, 'N093')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 50, 3, 1, 0, 15, 310, 1, 0.5, 0, 5, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '런천미트(캔햄)', NULL, '사조', NULL, 'general', 60, NULL, NULL, 'public_nutrition', NULL, 'N095')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 185, 16, 6, 0.3, 30, 580, 3, 1, 0, 7, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '참치캔 라이트(동원)', NULL, '동원', NULL, 'general', 60, NULL, NULL, 'public_nutrition', NULL, 'N096')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 95, 4.5, 1, 0, 25, 200, 0, 0, 0, 13, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '어묵바(수산)', NULL, '사조', NULL, 'general', 70, NULL, NULL, 'public_nutrition', NULL, 'N097')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 85, 2, 0.5, 0, 15, 520, 11, 3, 0.5, 6, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '참치마요(캔)', NULL, '오뚜기', NULL, 'general', 50, NULL, NULL, 'public_nutrition', NULL, 'N098')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 150, 12, 2, 0, 20, 250, 3, 1, 0, 7, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '풀무원 유기농두유', NULL, '풀무원', NULL, 'beverage', 190, NULL, NULL, 'public_nutrition', NULL, 'N103')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 120, 4, 0.5, 0, 0, 95, 14, 8, 1.5, 7, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '비비고 수제 진한만두', NULL, 'CJ', NULL, 'general', 120, NULL, NULL, 'public_nutrition', NULL, 'N104')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 260, 10, 3, 0.1, 25, 520, 32, 3, 2, 10, 'public_nutrition');

INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
VALUES (NULL, '삼양 까르보나라불닭', NULL, '삼양식품', NULL, 'general', 140, NULL, NULL, 'public_nutrition', NULL, 'N105')
ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();
INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
VALUES (currval('products_product_id_seq'), 550, 18, 8, 0, 5, 1650, 85, 6, 2, 9, 'public_nutrition');
