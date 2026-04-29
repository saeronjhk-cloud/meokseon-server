/**
 * 먹선 100개 한국 시판 제품 샘플 데이터
 * 카테고리별 분포: 과자 12, 라면/면류 10, 음료 15, 유제품 8, 발효식품 6,
 *   건조식품 6, 냉동/간편식 10, 소스/양념 6, 빵/디저트 8, 건강기능식품 3,
 *   주류 3, 유지류 3, 육가공 5, 수산가공 3, 두부/콩 2
 *
 * 각 제품은 실제 한국 시장 제품을 참고하여 현실적인 영양성분 수치로 구성
 */

// C005 바코드연계 정보 (제품 기본정보)
const c005Data = [
  // ── 과자류 (12) ──
  { product_name: '새우깡', manufacturer: '(주)농심', food_type: '과자', barcode: '8801043012607', report_no: 'R001', serving_size: 30, total_content: 90, content_unit: 'g' },
  { product_name: '포카칩 오리지널', manufacturer: '(주)오리온', food_type: '스낵', barcode: '8801117211004', report_no: 'R002', serving_size: 30, total_content: 66, content_unit: 'g' },
  { product_name: '꼬깔콘 고소한맛', manufacturer: '롯데웰푸드(주)', food_type: '스낵', barcode: '8801062333806', report_no: 'R003', serving_size: 30, total_content: 72, content_unit: 'g' },
  { product_name: '칸쵸 초코', manufacturer: '롯데웰푸드(주)', food_type: '비스킷', barcode: '8801062634507', report_no: 'R004', serving_size: 36, total_content: 72, content_unit: 'g' },
  { product_name: '오예스', manufacturer: '해태제과식품(주)', food_type: '케이크', barcode: '8801019303401', report_no: 'R005', serving_size: 30, total_content: 360, content_unit: 'g' },
  { product_name: '빼빼로 초코', manufacturer: '롯데웰푸드(주)', food_type: '비스킷', barcode: '8801062027507', report_no: 'R006', serving_size: 27, total_content: 54, content_unit: 'g' },
  { product_name: '프링글스 오리지널', manufacturer: '켈로그(주)', food_type: '감자칩', barcode: '8801037062908', report_no: 'R007', serving_size: 25, total_content: 110, content_unit: 'g' },
  { product_name: '허니버터칩', manufacturer: '해태제과식품(주)', food_type: '스낵', barcode: '8801019607806', report_no: 'R008', serving_size: 30, total_content: 60, content_unit: 'g' },
  { product_name: '고래밥 볶음양념맛', manufacturer: '(주)오리온', food_type: '스낵', barcode: '8801117779603', report_no: 'R009', serving_size: 40, total_content: 40, content_unit: 'g' },
  { product_name: '양파링', manufacturer: '(주)농심', food_type: '스낵', barcode: '8801043013000', report_no: 'R010', serving_size: 30, total_content: 84, content_unit: 'g' },
  { product_name: '초코파이', manufacturer: '(주)오리온', food_type: '파이', barcode: '8801117100100', report_no: 'R011', serving_size: 35, total_content: 420, content_unit: 'g' },
  { product_name: '마가렛트', manufacturer: '롯데웰푸드(주)', food_type: '쿠키', barcode: '8801062001200', report_no: 'R012', serving_size: 22, total_content: 176, content_unit: 'g' },

  // ── 라면/면류 (10) ──
  { product_name: '신라면', manufacturer: '(주)농심', food_type: '유탕면류', barcode: '8801043032704', report_no: 'R013', serving_size: 120, total_content: 120, content_unit: 'g' },
  { product_name: '진라면 순한맛', manufacturer: '(주)오뚜기', food_type: '유탕면류', barcode: '8801045520001', report_no: 'R014', serving_size: 120, total_content: 120, content_unit: 'g' },
  { product_name: '너구리', manufacturer: '(주)농심', food_type: '유탕면류', barcode: '8801043032902', report_no: 'R015', serving_size: 120, total_content: 120, content_unit: 'g' },
  { product_name: '짜파게티', manufacturer: '(주)농심', food_type: '유탕면류', barcode: '8801043033008', report_no: 'R016', serving_size: 140, total_content: 140, content_unit: 'g' },
  { product_name: '삼양라면', manufacturer: '삼양식품(주)', food_type: '유탕면류', barcode: '8801073100107', report_no: 'R017', serving_size: 120, total_content: 120, content_unit: 'g' },
  { product_name: '불닭볶음면', manufacturer: '삼양식품(주)', food_type: '유탕면류', barcode: '8801073110809', report_no: 'R018', serving_size: 140, total_content: 140, content_unit: 'g' },
  { product_name: '신라면 컵', manufacturer: '(주)농심', food_type: '유탕면류', barcode: '8801043032711', report_no: 'R019', serving_size: 65, total_content: 65, content_unit: 'g' },
  { product_name: '컵누들 매콤한맛', manufacturer: '(주)농심', food_type: '면류', barcode: '8801043036306', report_no: 'R020', serving_size: 37.5, total_content: 37.5, content_unit: 'g' },
  { product_name: '안성탕면', manufacturer: '(주)농심', food_type: '유탕면류', barcode: '8801043032308', report_no: 'R021', serving_size: 125, total_content: 125, content_unit: 'g' },
  { product_name: '비빔면', manufacturer: '팔도(주)', food_type: '유탕면류', barcode: '8803900020101', report_no: 'R022', serving_size: 130, total_content: 130, content_unit: 'g' },

  // ── 음료 (15) ──
  { product_name: '코카콜라 제로', manufacturer: '한국코카콜라(주)', food_type: '탄산음료', barcode: '8806007045052', report_no: 'R023', serving_size: 250, total_content: 500, content_unit: 'ml' },
  { product_name: '펩시콜라', manufacturer: '롯데칠성음료(주)', food_type: '탄산음료', barcode: '8801056037802', report_no: 'R024', serving_size: 250, total_content: 500, content_unit: 'ml' },
  { product_name: '델몬트 오렌지주스 100%', manufacturer: '롯데칠성음료(주)', food_type: '과채주스', barcode: '8801056099009', report_no: 'R025', serving_size: 200, total_content: 1000, content_unit: 'ml' },
  { product_name: '제주 삼다수', manufacturer: '제주특별자치도개발공사', food_type: '먹는샘물', barcode: '8809254990002', report_no: 'R026', serving_size: 500, total_content: 500, content_unit: 'ml' },
  { product_name: '포카리스웨트', manufacturer: '동아오츠카(주)', food_type: '음료류', barcode: '8801037010008', report_no: 'R027', serving_size: 250, total_content: 500, content_unit: 'ml' },
  { product_name: '비타500', manufacturer: '광동제약(주)', food_type: '음료류', barcode: '8801045050003', report_no: 'R028', serving_size: 100, total_content: 100, content_unit: 'ml' },
  { product_name: '밀키스', manufacturer: '롯데칠성음료(주)', food_type: '탄산음료', barcode: '8801056020507', report_no: 'R029', serving_size: 250, total_content: 250, content_unit: 'ml' },
  { product_name: '토레타', manufacturer: '한국코카콜라(주)', food_type: '음료류', barcode: '8806007019053', report_no: 'R030', serving_size: 240, total_content: 240, content_unit: 'ml' },
  { product_name: '아메리카노 T.O.P', manufacturer: '동서식품(주)', food_type: '커피음료', barcode: '8801037070002', report_no: 'R031', serving_size: 275, total_content: 275, content_unit: 'ml' },
  { product_name: '맥스웰하우스 T.O.P 스위트아메리카노', manufacturer: '동서식품(주)', food_type: '커피음료', barcode: '8801037080001', report_no: 'R032', serving_size: 275, total_content: 275, content_unit: 'ml' },
  { product_name: '칸타타 콘트라베이스', manufacturer: '롯데칠성음료(주)', food_type: '커피음료', barcode: '8801056090006', report_no: 'R033', serving_size: 275, total_content: 500, content_unit: 'ml' },
  { product_name: '헛개수', manufacturer: 'CJ제일제당(주)', food_type: '음료류', barcode: '8801007100005', report_no: 'R034', serving_size: 250, total_content: 500, content_unit: 'ml' },
  { product_name: '옥수수수염차', manufacturer: '광동제약(주)', food_type: '음료류', barcode: '8801045060002', report_no: 'R035', serving_size: 250, total_content: 500, content_unit: 'ml' },
  { product_name: '매일 바나나우유', manufacturer: '매일유업(주)', food_type: '가공유류', barcode: '8801120170004', report_no: 'R036', serving_size: 200, total_content: 200, content_unit: 'ml' },
  { product_name: '빙그레 바나나맛우유', manufacturer: '빙그레(주)', food_type: '가공유류', barcode: '8801104200004', report_no: 'R037', serving_size: 240, total_content: 240, content_unit: 'ml' },

  // ── 유제품 (8) ──
  { product_name: '서울우유 1급A', manufacturer: '서울우유협동조합', food_type: '우유류', barcode: '8801115112006', report_no: 'R038', serving_size: 200, total_content: 1000, content_unit: 'ml' },
  { product_name: '매일 저지방우유', manufacturer: '매일유업(주)', food_type: '우유류', barcode: '8801120310001', report_no: 'R039', serving_size: 200, total_content: 1000, content_unit: 'ml' },
  { product_name: '비요뜨 딸기', manufacturer: 'CJ제일제당(주)', food_type: '발효유류', barcode: '8801007330002', report_no: 'R040', serving_size: 143, total_content: 143, content_unit: 'g' },
  { product_name: '액티비아 플레인', manufacturer: '풀무원다논(주)', food_type: '발효유류', barcode: '8801069450003', report_no: 'R041', serving_size: 80, total_content: 80, content_unit: 'g' },
  { product_name: '서울우유 체다 슬라이스치즈', manufacturer: '서울우유협동조합', food_type: '치즈류', barcode: '8801115550004', report_no: 'R042', serving_size: 18, total_content: 270, content_unit: 'g' },
  { product_name: '덴마크 드링킹요거트 딸기', manufacturer: '동원F&B(주)', food_type: '발효유류', barcode: '8801047300001', report_no: 'R043', serving_size: 150, total_content: 150, content_unit: 'ml' },
  { product_name: '매일 상하목장 유기농우유', manufacturer: '매일유업(주)', food_type: '우유류', barcode: '8801120890003', report_no: 'R044', serving_size: 200, total_content: 900, content_unit: 'ml' },
  { product_name: '빙그레 끼리 크림치즈', manufacturer: '빙그레(주)', food_type: '치즈류', barcode: '8801104880002', report_no: 'R045', serving_size: 18, total_content: 200, content_unit: 'g' },

  // ── 발효식품 (6) ──
  { product_name: '종가 맛김치', manufacturer: '(주)대상', food_type: '김치류', barcode: '8801052720005', report_no: 'R046', serving_size: 40, total_content: 500, content_unit: 'g' },
  { product_name: '해찬들 태양초 고추장', manufacturer: 'CJ제일제당(주)', food_type: '장류', barcode: '8801007150000', report_no: 'R047', serving_size: 15, total_content: 500, content_unit: 'g' },
  { product_name: '샘표 양조간장 501', manufacturer: '샘표식품(주)', food_type: '장류', barcode: '8801005001007', report_no: 'R048', serving_size: 15, total_content: 500, content_unit: 'ml' },
  { product_name: '청정원 순창 된장', manufacturer: '(주)대상', food_type: '장류', barcode: '8801052440002', report_no: 'R049', serving_size: 15, total_content: 500, content_unit: 'g' },
  { product_name: '풀무원 깍두기', manufacturer: '(주)풀무원', food_type: '김치류', barcode: '8801069770005', report_no: 'R050', serving_size: 40, total_content: 500, content_unit: 'g' },
  { product_name: '비비고 열무김치', manufacturer: 'CJ제일제당(주)', food_type: '김치류', barcode: '8801007660003', report_no: 'R051', serving_size: 40, total_content: 500, content_unit: 'g' },

  // ── 건조식품 (6) ──
  { product_name: '쇠고기 육포', manufacturer: '(주)사조대림', food_type: '육포', barcode: '8801068100001', report_no: 'R052', serving_size: 25, total_content: 50, content_unit: 'g' },
  { product_name: '동원 양반김 도시락김', manufacturer: '동원F&B(주)', food_type: '김류', barcode: '8801047200004', report_no: 'R053', serving_size: 5, total_content: 25, content_unit: 'g' },
  { product_name: '건조 망고', manufacturer: '(주)길림양행', food_type: '건과류', barcode: '8809045000002', report_no: 'R054', serving_size: 30, total_content: 100, content_unit: 'g' },
  { product_name: '대상 미원', manufacturer: '(주)대상', food_type: '조미료', barcode: '8801052200002', report_no: 'R055', serving_size: 1, total_content: 100, content_unit: 'g' },
  { product_name: 'CJ 다시다', manufacturer: 'CJ제일제당(주)', food_type: '조미료', barcode: '8801007170008', report_no: 'R056', serving_size: 3, total_content: 100, content_unit: 'g' },
  { product_name: '오뚜기 카레 분말', manufacturer: '(주)오뚜기', food_type: '분말식품', barcode: '8801045090009', report_no: 'R057', serving_size: 20, total_content: 100, content_unit: 'g' },

  // ── 냉동/간편식 (10) ──
  { product_name: '비비고 왕교자', manufacturer: 'CJ제일제당(주)', food_type: '만두류', barcode: '8801007654321', report_no: 'R058', serving_size: 120, total_content: 350, content_unit: 'g' },
  { product_name: '풀무원 얇은피 꽃만두', manufacturer: '(주)풀무원', food_type: '만두류', barcode: '8801069880001', report_no: 'R059', serving_size: 120, total_content: 420, content_unit: 'g' },
  { product_name: '오뚜기 3분 카레', manufacturer: '(주)오뚜기', food_type: '레토르트식품', barcode: '8801045530000', report_no: 'R060', serving_size: 200, total_content: 200, content_unit: 'g' },
  { product_name: 'CJ 햇반 백미', manufacturer: 'CJ제일제당(주)', food_type: '즉석밥', barcode: '8801007200003', report_no: 'R061', serving_size: 210, total_content: 210, content_unit: 'g' },
  { product_name: '동원 리얼참치 김밥', manufacturer: '동원F&B(주)', food_type: '김밥', barcode: '8801047880001', report_no: 'R062', serving_size: 230, total_content: 230, content_unit: 'g' },
  { product_name: '풀무원 생면식감 냉면', manufacturer: '(주)풀무원', food_type: '면류', barcode: '8801069990001', report_no: 'R063', serving_size: 462, total_content: 462, content_unit: 'g' },
  { product_name: '오뚜기 진짬뽕', manufacturer: '(주)오뚜기', food_type: '즉석조리식품', barcode: '8801045550008', report_no: 'R064', serving_size: 230, total_content: 230, content_unit: 'g' },
  { product_name: '교촌 허니콤보 치킨', manufacturer: '(주)교촌에프앤비', food_type: '즉석조리식품', barcode: '8809990000001', report_no: 'R065', serving_size: 150, total_content: 350, content_unit: 'g' },
  { product_name: 'CJ 고메 크로크무슈', manufacturer: 'CJ제일제당(주)', food_type: '즉석조리식품', barcode: '8801007350002', report_no: 'R066', serving_size: 100, total_content: 200, content_unit: 'g' },
  { product_name: '오뚜기 냉동 볶음밥', manufacturer: '(주)오뚜기', food_type: '즉석조리식품', barcode: '8801045570006', report_no: 'R067', serving_size: 300, total_content: 450, content_unit: 'g' },

  // ── 소스/양념 (6) ──
  { product_name: '오뚜기 토마토 케첩', manufacturer: '(주)오뚜기', food_type: '소스류', barcode: '8801045500008', report_no: 'R068', serving_size: 15, total_content: 300, content_unit: 'g' },
  { product_name: '청정원 카놀라유', manufacturer: '(주)대상', food_type: '유지류', barcode: '8801052600000', report_no: 'R069', serving_size: 15, total_content: 900, content_unit: 'ml' },
  { product_name: '오뚜기 마요네즈', manufacturer: '(주)오뚜기', food_type: '소스류', barcode: '8801045510007', report_no: 'R070', serving_size: 13, total_content: 300, content_unit: 'g' },
  { product_name: '샘표 맛간장', manufacturer: '샘표식품(주)', food_type: '장류', barcode: '8801005010009', report_no: 'R071', serving_size: 15, total_content: 500, content_unit: 'ml' },
  { product_name: '백설 올리고당', manufacturer: 'CJ제일제당(주)', food_type: '당류가공품', barcode: '8801007400004', report_no: 'R072', serving_size: 15, total_content: 700, content_unit: 'g' },
  { product_name: '청정원 스리라차 소스', manufacturer: '(주)대상', food_type: '소스류', barcode: '8801052700008', report_no: 'R073', serving_size: 10, total_content: 215, content_unit: 'ml' },

  // ── 빵/디저트 (8) ──
  { product_name: '삼립 미니꿀호떡', manufacturer: 'SPC삼립(주)', food_type: '빵류', barcode: '8801068300002', report_no: 'R074', serving_size: 30, total_content: 192, content_unit: 'g' },
  { product_name: '파리바게뜨 모닝롤', manufacturer: '(주)파리크라상', food_type: '빵류', barcode: '8809990100002', report_no: 'R075', serving_size: 35, total_content: 280, content_unit: 'g' },
  { product_name: '삼립 크림빵', manufacturer: 'SPC삼립(주)', food_type: '빵류', barcode: '8801068400000', report_no: 'R076', serving_size: 90, total_content: 90, content_unit: 'g' },
  { product_name: '롯데 빈츠', manufacturer: '롯데웰푸드(주)', food_type: '비스킷', barcode: '8801062200702', report_no: 'R077', serving_size: 28, total_content: 102, content_unit: 'g' },
  { product_name: '해태 에이스', manufacturer: '해태제과식품(주)', food_type: '크래커', barcode: '8801019200007', report_no: 'R078', serving_size: 28, total_content: 218, content_unit: 'g' },
  { product_name: '농심 바나나킥', manufacturer: '(주)농심', food_type: '스낵', barcode: '8801043020008', report_no: 'R079', serving_size: 27, total_content: 75, content_unit: 'g' },
  { product_name: '롯데 몽쉘', manufacturer: '롯데웰푸드(주)', food_type: '케이크', barcode: '8801062300005', report_no: 'R080', serving_size: 32, total_content: 384, content_unit: 'g' },
  { product_name: '해태 자유시간', manufacturer: '해태제과식품(주)', food_type: '초콜릿', barcode: '8801019400002', report_no: 'R081', serving_size: 35, total_content: 70, content_unit: 'g' },

  // ── 건강기능식품 (3) — 평가 제외 대상 ──
  { product_name: '정관장 홍삼정 에브리타임', manufacturer: '(주)KGC인삼공사', food_type: '건강기능식품', barcode: '8809015930001', report_no: 'R082', serving_size: 10, total_content: 300, content_unit: 'ml' },
  { product_name: '종근당 비타민C 1000', manufacturer: '(주)종근당건강', food_type: '건강기능식품', barcode: '8809260000002', report_no: 'R083', serving_size: 1, total_content: 60, content_unit: 'g' },
  { product_name: '뉴트리원 유산균', manufacturer: '(주)뉴트리원', food_type: '건강기능식품', barcode: '8809370000001', report_no: 'R084', serving_size: 2, total_content: 60, content_unit: 'g' },

  // ── 주류 (3) — 평가 제외 대상 ──
  { product_name: '참이슬', manufacturer: '하이트진로(주)', food_type: '소주', barcode: '8801055600001', report_no: 'R085', serving_size: 50, total_content: 360, content_unit: 'ml' },
  { product_name: '카스 프레시', manufacturer: '오비맥주(주)', food_type: '맥주', barcode: '8801069800002', report_no: 'R086', serving_size: 355, total_content: 355, content_unit: 'ml' },
  { product_name: '처음처럼', manufacturer: '롯데칠성음료(주)', food_type: '소주', barcode: '8801056200009', report_no: 'R087', serving_size: 50, total_content: 360, content_unit: 'ml' },

  // ── 유지류 (3) ──
  { product_name: '엑스트라 버진 올리브유', manufacturer: 'CJ제일제당(주)', food_type: '유지류', barcode: '8801007500001', report_no: 'R088', serving_size: 15, total_content: 500, content_unit: 'ml' },
  { product_name: '오뚜기 참기름', manufacturer: '(주)오뚜기', food_type: '식용유지', barcode: '8801045520009', report_no: 'R089', serving_size: 15, total_content: 320, content_unit: 'ml' },
  { product_name: '백설 포도씨유', manufacturer: 'CJ제일제당(주)', food_type: '유지류', barcode: '8801007600006', report_no: 'R090', serving_size: 15, total_content: 900, content_unit: 'ml' },

  // ── 육가공 (5) ──
  { product_name: '목우촌 뚝심 소시지', manufacturer: '(주)목우촌', food_type: '소시지류', barcode: '8801152100003', report_no: 'R091', serving_size: 60, total_content: 300, content_unit: 'g' },
  { product_name: 'CJ 맥스봉', manufacturer: 'CJ제일제당(주)', food_type: '소시지류', barcode: '8801007700005', report_no: 'R092', serving_size: 27, total_content: 270, content_unit: 'g' },
  { product_name: '동원 리얼 햄', manufacturer: '동원F&B(주)', food_type: '햄류', barcode: '8801047500001', report_no: 'R093', serving_size: 30, total_content: 200, content_unit: 'g' },
  { product_name: '하림 더미식 닭가슴살', manufacturer: '(주)하림', food_type: '즉석조리식품', barcode: '8801492300001', report_no: 'R094', serving_size: 100, total_content: 100, content_unit: 'g' },
  { product_name: '사조 런천미트', manufacturer: '(주)사조대림', food_type: '캔햄', barcode: '8801068500002', report_no: 'R095', serving_size: 60, total_content: 340, content_unit: 'g' },

  // ── 수산가공 (3) ──
  { product_name: '동원 참치 라이트스탠다드', manufacturer: '동원F&B(주)', food_type: '참치캔', barcode: '8801047100008', report_no: 'R096', serving_size: 60, total_content: 150, content_unit: 'g' },
  { product_name: '사조 어묵바', manufacturer: '(주)사조대림', food_type: '어묵류', barcode: '8801068600000', report_no: 'R097', serving_size: 70, total_content: 200, content_unit: 'g' },
  { product_name: '오뚜기 참치 마요', manufacturer: '(주)오뚜기', food_type: '참치캔', barcode: '8801045600001', report_no: 'R098', serving_size: 50, total_content: 100, content_unit: 'g' },

  // ── 두부/콩 (2) ──
  { product_name: '풀무원 국산콩 두부', manufacturer: '(주)풀무원', food_type: '두부류', barcode: '8801069123456', report_no: 'R099', serving_size: 100, total_content: 300, content_unit: 'g' },
  { product_name: '삼육 검은콩 두유', manufacturer: '삼육식품(주)', food_type: '두유류', barcode: '8801026600001', report_no: 'R100', serving_size: 190, total_content: 190, content_unit: 'ml' },
];

// 영양성분 DB (약간 다른 이름으로 퍼지 매칭 테스트)
const nutritionData = [
  // 과자류
  { product_name: '새우깡(스낵)', manufacturer: '농심', food_cd: 'N001', serving_size: 30, nutrition: { calories: 140, protein: 2, total_fat: 7, total_carbs: 18, total_sugars: 2, sodium: 200, cholesterol: 5, saturated_fat: 1.5, trans_fat: 0, dietary_fiber: 0.5 }},
  { product_name: '포카칩 오리지널(감자칩)', manufacturer: '오리온', food_cd: 'N002', serving_size: 30, nutrition: { calories: 160, protein: 1.5, total_fat: 10, total_carbs: 17, total_sugars: 0.5, sodium: 170, cholesterol: 0, saturated_fat: 3, trans_fat: 0, dietary_fiber: 1 }},
  { product_name: '꼬깔콘', manufacturer: '롯데제과', food_cd: 'N003', serving_size: 30, nutrition: { calories: 160, protein: 1.5, total_fat: 9, total_carbs: 19, total_sugars: 3, sodium: 190, cholesterol: 0, saturated_fat: 4, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '칸쵸', manufacturer: '롯데제과', food_cd: 'N004', serving_size: 36, nutrition: { calories: 185, protein: 2.5, total_fat: 9, total_carbs: 24, total_sugars: 12, sodium: 110, cholesterol: 10, saturated_fat: 5, trans_fat: 0, dietary_fiber: 0.5 }},
  { product_name: '오예스 케이크', manufacturer: '해태', food_cd: 'N005', serving_size: 30, nutrition: { calories: 130, protein: 1.5, total_fat: 6, total_carbs: 19, total_sugars: 12, sodium: 75, cholesterol: 15, saturated_fat: 3.5, trans_fat: 0, dietary_fiber: 0.3 }},
  { product_name: '빼빼로', manufacturer: '롯데제과', food_cd: 'N006', serving_size: 27, nutrition: { calories: 140, protein: 2, total_fat: 7, total_carbs: 18, total_sugars: 11, sodium: 65, cholesterol: 5, saturated_fat: 4, trans_fat: 0, dietary_fiber: 0.5 }},
  { product_name: '프링글스(Original)', manufacturer: '켈로그', food_cd: 'N007', serving_size: 25, nutrition: { calories: 135, protein: 1, total_fat: 8.5, total_carbs: 14, total_sugars: 0.5, sodium: 135, cholesterol: 0, saturated_fat: 2.5, trans_fat: 0, dietary_fiber: 0.8 }},
  { product_name: '허니버터칩 감자칩', manufacturer: '해태', food_cd: 'N008', serving_size: 30, nutrition: { calories: 160, protein: 1.5, total_fat: 9, total_carbs: 19, total_sugars: 5, sodium: 130, cholesterol: 0, saturated_fat: 3, trans_fat: 0, dietary_fiber: 0.5 }},
  { product_name: '고래밥(스낵)', manufacturer: '오리온', food_cd: 'N009', serving_size: 40, nutrition: { calories: 180, protein: 3, total_fat: 6, total_carbs: 29, total_sugars: 5, sodium: 280, cholesterol: 10, saturated_fat: 2.5, trans_fat: 0, dietary_fiber: 0.5 }},
  { product_name: '양파링 스낵', manufacturer: '농심', food_cd: 'N010', serving_size: 30, nutrition: { calories: 150, protein: 1.5, total_fat: 8, total_carbs: 19, total_sugars: 3, sodium: 210, cholesterol: 0, saturated_fat: 3.5, trans_fat: 0, dietary_fiber: 0.3 }},
  { product_name: '초코파이(파이)', manufacturer: '오리온', food_cd: 'N011', serving_size: 35, nutrition: { calories: 150, protein: 2, total_fat: 6, total_carbs: 23, total_sugars: 15, sodium: 100, cholesterol: 10, saturated_fat: 3, trans_fat: 0, dietary_fiber: 0.5 }},
  { product_name: '마가렛트 쿠키', manufacturer: '롯데', food_cd: 'N012', serving_size: 22, nutrition: { calories: 105, protein: 1.2, total_fat: 5, total_carbs: 14, total_sugars: 6, sodium: 65, cholesterol: 10, saturated_fat: 2.5, trans_fat: 0, dietary_fiber: 0.2 }},

  // 라면/면류
  { product_name: '신라면(유탕면)', manufacturer: '농심', food_cd: 'N013', serving_size: 120, nutrition: { calories: 500, protein: 10, total_fat: 16, total_carbs: 78, total_sugars: 4, sodium: 1790, cholesterol: 0, saturated_fat: 7, trans_fat: 0, dietary_fiber: 3 }},
  { product_name: '진라면 순한맛(유탕면)', manufacturer: '오뚜기', food_cd: 'N014', serving_size: 120, nutrition: { calories: 485, protein: 9, total_fat: 16, total_carbs: 75, total_sugars: 5, sodium: 1550, cholesterol: 0, saturated_fat: 7, trans_fat: 0, dietary_fiber: 2 }},
  { product_name: '너구리(유탕면)', manufacturer: '농심', food_cd: 'N015', serving_size: 120, nutrition: { calories: 490, protein: 9, total_fat: 15, total_carbs: 79, total_sugars: 5, sodium: 1630, cholesterol: 0, saturated_fat: 6.5, trans_fat: 0, dietary_fiber: 2 }},
  { product_name: '짜파게티(유탕면)', manufacturer: '농심', food_cd: 'N016', serving_size: 140, nutrition: { calories: 590, protein: 10, total_fat: 21, total_carbs: 89, total_sugars: 5, sodium: 1360, cholesterol: 0, saturated_fat: 9, trans_fat: 0, dietary_fiber: 2.5 }},
  { product_name: '삼양라면(유탕면)', manufacturer: '삼양식품', food_cd: 'N017', serving_size: 120, nutrition: { calories: 490, protein: 9, total_fat: 16, total_carbs: 76, total_sugars: 3, sodium: 1520, cholesterol: 0, saturated_fat: 7, trans_fat: 0, dietary_fiber: 2 }},
  { product_name: '불닭볶음면(유탕면)', manufacturer: '삼양식품', food_cd: 'N018', serving_size: 140, nutrition: { calories: 530, protein: 9, total_fat: 16, total_carbs: 87, total_sugars: 7, sodium: 1830, cholesterol: 0, saturated_fat: 7.5, trans_fat: 0, dietary_fiber: 2 }},
  { product_name: '신라면컵(유탕면)', manufacturer: '농심', food_cd: 'N019', serving_size: 65, nutrition: { calories: 280, protein: 6, total_fat: 10, total_carbs: 42, total_sugars: 4, sodium: 1600, cholesterol: 0, saturated_fat: 3.5, trans_fat: 0, dietary_fiber: 2 }},
  { product_name: '컵누들(면류)', manufacturer: '농심', food_cd: 'N020', serving_size: 37.5, nutrition: { calories: 165, protein: 4, total_fat: 7, total_carbs: 21, total_sugars: 2, sodium: 720, cholesterol: 10, saturated_fat: 3, trans_fat: 0, dietary_fiber: 1 }},
  { product_name: '안성탕면(유탕면)', manufacturer: '농심', food_cd: 'N021', serving_size: 125, nutrition: { calories: 520, protein: 10, total_fat: 18, total_carbs: 78, total_sugars: 6, sodium: 1680, cholesterol: 0, saturated_fat: 8, trans_fat: 0, dietary_fiber: 2.5 }},
  { product_name: '비빔면(유탕면)', manufacturer: '팔도', food_cd: 'N022', serving_size: 130, nutrition: { calories: 490, protein: 9, total_fat: 14, total_carbs: 81, total_sugars: 14, sodium: 1170, cholesterol: 0, saturated_fat: 6, trans_fat: 0, dietary_fiber: 2 }},

  // 음료
  { product_name: '코카콜라 제로 500ml', manufacturer: '코카콜라', food_cd: 'N023', serving_size: 250, nutrition: { calories: 0, protein: 0, total_fat: 0, total_carbs: 0, total_sugars: 0, sodium: 25, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '펩시콜라 500ml', manufacturer: '롯데칠성', food_cd: 'N024', serving_size: 250, nutrition: { calories: 115, protein: 0, total_fat: 0, total_carbs: 29, total_sugars: 28, sodium: 20, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '델몬트 오렌지 100%', manufacturer: '롯데칠성', food_cd: 'N025', serving_size: 200, nutrition: { calories: 88, protein: 1, total_fat: 0, total_carbs: 21, total_sugars: 18, sodium: 10, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0.5 }},
  { product_name: '제주삼다수(먹는샘물)', manufacturer: '제주도개발공사', food_cd: 'N026', serving_size: 500, nutrition: { calories: 0, protein: 0, total_fat: 0, total_carbs: 0, total_sugars: 0, sodium: 3.6, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '포카리스웨트(이온음료)', manufacturer: '동아오츠카', food_cd: 'N027', serving_size: 250, nutrition: { calories: 63, protein: 0, total_fat: 0, total_carbs: 15.5, total_sugars: 14, sodium: 123, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '비타500(비타민음료)', manufacturer: '광동제약', food_cd: 'N028', serving_size: 100, nutrition: { calories: 45, protein: 0, total_fat: 0, total_carbs: 11, total_sugars: 10, sodium: 10, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '밀키스(유성탄산)', manufacturer: '롯데칠성', food_cd: 'N029', serving_size: 250, nutrition: { calories: 105, protein: 0.5, total_fat: 0, total_carbs: 26, total_sugars: 23, sodium: 30, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '토레타(이온음료)', manufacturer: '코카콜라', food_cd: 'N030', serving_size: 240, nutrition: { calories: 53, protein: 0, total_fat: 0, total_carbs: 13, total_sugars: 13, sodium: 50, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: 'T.O.P 아메리카노', manufacturer: '동서식품', food_cd: 'N031', serving_size: 275, nutrition: { calories: 15, protein: 0.5, total_fat: 0, total_carbs: 3, total_sugars: 2, sodium: 55, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: 'T.O.P 스위트아메리카노', manufacturer: '동서식품', food_cd: 'N032', serving_size: 275, nutrition: { calories: 60, protein: 1, total_fat: 0.5, total_carbs: 13, total_sugars: 12, sodium: 60, cholesterol: 0, saturated_fat: 0.3, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '칸타타 콘트라베이스(커피)', manufacturer: '롯데칠성', food_cd: 'N033', serving_size: 275, nutrition: { calories: 35, protein: 1, total_fat: 0.5, total_carbs: 7, total_sugars: 6, sodium: 60, cholesterol: 0, saturated_fat: 0.3, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '헛개수(음료)', manufacturer: 'CJ제일제당', food_cd: 'N034', serving_size: 250, nutrition: { calories: 0, protein: 0, total_fat: 0, total_carbs: 0, total_sugars: 0, sodium: 30, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '옥수수수염차(음료)', manufacturer: '광동제약', food_cd: 'N035', serving_size: 250, nutrition: { calories: 0, protein: 0, total_fat: 0, total_carbs: 0, total_sugars: 0, sodium: 25, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '매일 바나나맛우유', manufacturer: '매일유업', food_cd: 'N036', serving_size: 200, nutrition: { calories: 170, protein: 5, total_fat: 3.5, total_carbs: 30, total_sugars: 27, sodium: 115, cholesterol: 15, saturated_fat: 2, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '빙그레 바나나맛우유', manufacturer: '빙그레', food_cd: 'N037', serving_size: 240, nutrition: { calories: 220, protein: 6, total_fat: 5, total_carbs: 37, total_sugars: 34, sodium: 140, cholesterol: 20, saturated_fat: 3.5, trans_fat: 0, dietary_fiber: 0 }},

  // 유제품
  { product_name: '서울우유', manufacturer: '서울우유', food_cd: 'N038', serving_size: 200, nutrition: { calories: 130, protein: 6, total_fat: 7, total_carbs: 10, total_sugars: 9, sodium: 100, cholesterol: 25, saturated_fat: 4.5, trans_fat: 0.2, dietary_fiber: 0 }},
  { product_name: '매일 저지방 우유', manufacturer: '매일유업', food_cd: 'N039', serving_size: 200, nutrition: { calories: 80, protein: 6.5, total_fat: 2, total_carbs: 10, total_sugars: 9, sodium: 100, cholesterol: 10, saturated_fat: 1.2, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '비요뜨(발효유)', manufacturer: 'CJ', food_cd: 'N040', serving_size: 143, nutrition: { calories: 185, protein: 4, total_fat: 4, total_carbs: 33, total_sugars: 28, sodium: 75, cholesterol: 10, saturated_fat: 2.5, trans_fat: 0, dietary_fiber: 0.5 }},
  { product_name: '액티비아 요거트', manufacturer: '다논', food_cd: 'N041', serving_size: 80, nutrition: { calories: 58, protein: 3, total_fat: 1, total_carbs: 9.5, total_sugars: 7, sodium: 40, cholesterol: 5, saturated_fat: 0.6, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '체다슬라이스 치즈', manufacturer: '서울우유', food_cd: 'N042', serving_size: 18, nutrition: { calories: 55, protein: 3, total_fat: 4.5, total_carbs: 0.5, total_sugars: 0, sodium: 230, cholesterol: 15, saturated_fat: 3, trans_fat: 0.1, dietary_fiber: 0 }},
  { product_name: '덴마크 드링킹 요거트', manufacturer: '동원', food_cd: 'N043', serving_size: 150, nutrition: { calories: 120, protein: 3.5, total_fat: 1.5, total_carbs: 23, total_sugars: 20, sodium: 60, cholesterol: 5, saturated_fat: 1, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '상하목장 유기농 우유', manufacturer: '매일유업', food_cd: 'N044', serving_size: 200, nutrition: { calories: 130, protein: 6, total_fat: 7, total_carbs: 9, total_sugars: 9, sodium: 95, cholesterol: 25, saturated_fat: 4.5, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '끼리크림치즈', manufacturer: '빙그레', food_cd: 'N045', serving_size: 18, nutrition: { calories: 52, protein: 1, total_fat: 5, total_carbs: 0.7, total_sugars: 0.5, sodium: 55, cholesterol: 15, saturated_fat: 3.3, trans_fat: 0, dietary_fiber: 0 }},

  // 발효식품
  { product_name: '종가집 맛김치(김치)', manufacturer: '대상', food_cd: 'N046', serving_size: 40, nutrition: { calories: 15, protein: 1.2, total_fat: 0.3, total_carbs: 2.5, total_sugars: 1, sodium: 340, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 1.5 }},
  { product_name: '해찬들 고추장', manufacturer: 'CJ', food_cd: 'N047', serving_size: 15, nutrition: { calories: 30, protein: 1, total_fat: 0.3, total_carbs: 6, total_sugars: 3.5, sodium: 310, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0.5 }},
  { product_name: '샘표 간장 501S', manufacturer: '샘표', food_cd: 'N048', serving_size: 15, nutrition: { calories: 12, protein: 1.5, total_fat: 0, total_carbs: 1.5, total_sugars: 0.5, sodium: 920, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '청정원 순창된장', manufacturer: '대상', food_cd: 'N049', serving_size: 15, nutrition: { calories: 25, protein: 2, total_fat: 0.7, total_carbs: 2.5, total_sugars: 0.5, sodium: 720, cholesterol: 0, saturated_fat: 0.1, trans_fat: 0, dietary_fiber: 1 }},
  { product_name: '풀무원 깍두기(김치)', manufacturer: '풀무원', food_cd: 'N050', serving_size: 40, nutrition: { calories: 12, protein: 0.8, total_fat: 0.2, total_carbs: 2, total_sugars: 1, sodium: 280, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 1.2 }},
  { product_name: '비비고 열무김치(김치)', manufacturer: 'CJ', food_cd: 'N051', serving_size: 40, nutrition: { calories: 10, protein: 0.7, total_fat: 0.2, total_carbs: 1.8, total_sugars: 0.8, sodium: 250, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 1 }},

  // 건조식품
  { product_name: '쇠고기육포(간식)', manufacturer: '사조', food_cd: 'N052', serving_size: 25, nutrition: { calories: 80, protein: 15, total_fat: 1.5, total_carbs: 2.5, total_sugars: 2, sodium: 350, cholesterol: 20, saturated_fat: 0.5, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '양반김 도시락(김)', manufacturer: '동원', food_cd: 'N053', serving_size: 5, nutrition: { calories: 25, protein: 1.5, total_fat: 1.8, total_carbs: 0.5, total_sugars: 0, sodium: 55, cholesterol: 0, saturated_fat: 0.3, trans_fat: 0, dietary_fiber: 0.5 }},
  { product_name: '건조 망고(건과일)', manufacturer: '길림양행', food_cd: 'N054', serving_size: 30, nutrition: { calories: 95, protein: 0.5, total_fat: 0.2, total_carbs: 23, total_sugars: 20, sodium: 10, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 1.5 }},
  { product_name: '미원(MSG 조미료)', manufacturer: '대상', food_cd: 'N055', serving_size: 1, nutrition: { calories: 0, protein: 0, total_fat: 0, total_carbs: 0, total_sugars: 0, sodium: 130, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '다시다(조미료)', manufacturer: 'CJ', food_cd: 'N056', serving_size: 3, nutrition: { calories: 5, protein: 0.3, total_fat: 0, total_carbs: 0.8, total_sugars: 0.3, sodium: 520, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '오뚜기 카레(분말)', manufacturer: '오뚜기', food_cd: 'N057', serving_size: 20, nutrition: { calories: 75, protein: 1.5, total_fat: 3, total_carbs: 11, total_sugars: 2, sodium: 650, cholesterol: 0, saturated_fat: 1.5, trans_fat: 0, dietary_fiber: 1 }},

  // 냉동/간편식
  { product_name: '비비고 왕교자만두', manufacturer: 'CJ제일제당', food_cd: 'N058', serving_size: 120, nutrition: { calories: 240, protein: 9, total_fat: 8, total_carbs: 32, total_sugars: 3, sodium: 480, cholesterol: 20, saturated_fat: 2.5, trans_fat: 0, dietary_fiber: 2 }},
  { product_name: '얇은피만두(풀무원)', manufacturer: '풀무원', food_cd: 'N059', serving_size: 120, nutrition: { calories: 235, protein: 10, total_fat: 7, total_carbs: 33, total_sugars: 2.5, sodium: 450, cholesterol: 15, saturated_fat: 2, trans_fat: 0, dietary_fiber: 2 }},
  { product_name: '3분카레(레토르트)', manufacturer: '오뚜기', food_cd: 'N060', serving_size: 200, nutrition: { calories: 175, protein: 5, total_fat: 7, total_carbs: 23, total_sugars: 4, sodium: 870, cholesterol: 15, saturated_fat: 3, trans_fat: 0, dietary_fiber: 2 }},
  { product_name: 'CJ 햇반', manufacturer: 'CJ', food_cd: 'N061', serving_size: 210, nutrition: { calories: 315, protein: 5, total_fat: 0.5, total_carbs: 71, total_sugars: 0, sodium: 5, cholesterol: 0, saturated_fat: 0.1, trans_fat: 0, dietary_fiber: 1 }},
  { product_name: '리얼참치 김밥', manufacturer: '동원', food_cd: 'N062', serving_size: 230, nutrition: { calories: 380, protein: 12, total_fat: 10, total_carbs: 60, total_sugars: 5, sodium: 680, cholesterol: 25, saturated_fat: 2.5, trans_fat: 0, dietary_fiber: 2.5 }},
  { product_name: '풀무원 냉면(면류)', manufacturer: '풀무원', food_cd: 'N063', serving_size: 462, nutrition: { calories: 450, protein: 13, total_fat: 3, total_carbs: 93, total_sugars: 10, sodium: 2100, cholesterol: 30, saturated_fat: 1, trans_fat: 0, dietary_fiber: 4 }},
  { product_name: '진짬뽕(즉석)', manufacturer: '오뚜기', food_cd: 'N064', serving_size: 230, nutrition: { calories: 200, protein: 8, total_fat: 5, total_carbs: 30, total_sugars: 4, sodium: 1350, cholesterol: 20, saturated_fat: 2, trans_fat: 0, dietary_fiber: 3 }},
  { product_name: '교촌 허니콤보', manufacturer: '교촌', food_cd: 'N065', serving_size: 150, nutrition: { calories: 350, protein: 20, total_fat: 18, total_carbs: 25, total_sugars: 10, sodium: 720, cholesterol: 65, saturated_fat: 5, trans_fat: 0.3, dietary_fiber: 1 }},
  { product_name: '고메 크로크무슈', manufacturer: 'CJ', food_cd: 'N066', serving_size: 100, nutrition: { calories: 260, protein: 10, total_fat: 14, total_carbs: 23, total_sugars: 3, sodium: 550, cholesterol: 35, saturated_fat: 7, trans_fat: 0.2, dietary_fiber: 1 }},
  { product_name: '오뚜기 볶음밥(냉동)', manufacturer: '오뚜기', food_cd: 'N067', serving_size: 300, nutrition: { calories: 470, protein: 10, total_fat: 10, total_carbs: 83, total_sugars: 4, sodium: 950, cholesterol: 30, saturated_fat: 3, trans_fat: 0, dietary_fiber: 2 }},

  // 소스/양념
  { product_name: '오뚜기 케첩(소스)', manufacturer: '오뚜기', food_cd: 'N068', serving_size: 15, nutrition: { calories: 18, protein: 0.2, total_fat: 0, total_carbs: 4.5, total_sugars: 3.5, sodium: 170, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '청정원 카놀라유(유지)', manufacturer: '대상', food_cd: 'N069', serving_size: 15, nutrition: { calories: 120, protein: 0, total_fat: 14, total_carbs: 0, total_sugars: 0, sodium: 0, cholesterol: 0, saturated_fat: 1, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '오뚜기 마요네즈(소스)', manufacturer: '오뚜기', food_cd: 'N070', serving_size: 13, nutrition: { calories: 85, protein: 0.2, total_fat: 9, total_carbs: 0.5, total_sugars: 0.3, sodium: 95, cholesterol: 10, saturated_fat: 1.5, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '맛간장(장류)', manufacturer: '샘표', food_cd: 'N071', serving_size: 15, nutrition: { calories: 15, protein: 1.5, total_fat: 0, total_carbs: 2.5, total_sugars: 1, sodium: 850, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '백설 올리고당(시럽)', manufacturer: 'CJ', food_cd: 'N072', serving_size: 15, nutrition: { calories: 40, protein: 0, total_fat: 0, total_carbs: 10, total_sugars: 3, sodium: 15, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 2.5 }},
  { product_name: '스리라차 소스', manufacturer: '대상', food_cd: 'N073', serving_size: 10, nutrition: { calories: 10, protein: 0.2, total_fat: 0, total_carbs: 2, total_sugars: 1.5, sodium: 180, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},

  // 빵/디저트
  { product_name: '삼립 미니 꿀호떡', manufacturer: 'SPC삼립', food_cd: 'N074', serving_size: 30, nutrition: { calories: 100, protein: 1.5, total_fat: 2.5, total_carbs: 18, total_sugars: 8, sodium: 110, cholesterol: 5, saturated_fat: 1, trans_fat: 0, dietary_fiber: 0.3 }},
  { product_name: '모닝롤(빵)', manufacturer: '파리크라상', food_cd: 'N075', serving_size: 35, nutrition: { calories: 115, protein: 3, total_fat: 3.5, total_carbs: 18, total_sugars: 5, sodium: 150, cholesterol: 10, saturated_fat: 1.5, trans_fat: 0, dietary_fiber: 0.5 }},
  { product_name: '삼립 크림빵(빵)', manufacturer: 'SPC삼립', food_cd: 'N076', serving_size: 90, nutrition: { calories: 285, protein: 6, total_fat: 10, total_carbs: 42, total_sugars: 20, sodium: 230, cholesterol: 40, saturated_fat: 4, trans_fat: 0.1, dietary_fiber: 1 }},
  { product_name: '빈츠(비스킷)', manufacturer: '롯데', food_cd: 'N077', serving_size: 28, nutrition: { calories: 150, protein: 2, total_fat: 8, total_carbs: 18, total_sugars: 9, sodium: 80, cholesterol: 5, saturated_fat: 5, trans_fat: 0, dietary_fiber: 0.5 }},
  { product_name: '에이스(크래커)', manufacturer: '해태', food_cd: 'N078', serving_size: 28, nutrition: { calories: 130, protein: 2.5, total_fat: 5, total_carbs: 19, total_sugars: 3, sodium: 210, cholesterol: 0, saturated_fat: 2.5, trans_fat: 0, dietary_fiber: 0.5 }},
  { product_name: '바나나킥(스낵)', manufacturer: '농심', food_cd: 'N079', serving_size: 27, nutrition: { calories: 120, protein: 1, total_fat: 4, total_carbs: 20, total_sugars: 7, sodium: 85, cholesterol: 0, saturated_fat: 2, trans_fat: 0, dietary_fiber: 0.3 }},
  { product_name: '몽쉘(케이크)', manufacturer: '롯데', food_cd: 'N080', serving_size: 32, nutrition: { calories: 145, protein: 1.5, total_fat: 8, total_carbs: 17, total_sugars: 12, sodium: 75, cholesterol: 15, saturated_fat: 5, trans_fat: 0, dietary_fiber: 0.3 }},
  { product_name: '자유시간(초콜릿)', manufacturer: '해태', food_cd: 'N081', serving_size: 35, nutrition: { calories: 195, protein: 2.5, total_fat: 12, total_carbs: 20, total_sugars: 17, sodium: 45, cholesterol: 5, saturated_fat: 7, trans_fat: 0, dietary_fiber: 1 }},

  // 건강기능식품 (영양DB에도 있지만 판정 제외 대상)
  { product_name: '정관장 홍삼정(건기식)', manufacturer: 'KGC인삼', food_cd: 'N082', serving_size: 10, nutrition: { calories: 12, protein: 0.1, total_fat: 0, total_carbs: 3, total_sugars: 0, sodium: 5, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '비타민C 1000(건기식)', manufacturer: '종근당', food_cd: 'N083', serving_size: 1, nutrition: { calories: 4, protein: 0, total_fat: 0, total_carbs: 1, total_sugars: 0, sodium: 0, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '유산균 프로바이오틱스', manufacturer: '뉴트리원', food_cd: 'N084', serving_size: 2, nutrition: { calories: 5, protein: 0.2, total_fat: 0, total_carbs: 1, total_sugars: 0, sodium: 0, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},

  // 주류
  { product_name: '참이슬(소주)', manufacturer: '하이트진로', food_cd: 'N085', serving_size: 50, nutrition: { calories: 64, protein: 0, total_fat: 0, total_carbs: 0, total_sugars: 0, sodium: 0, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '카스 프레시(맥주)', manufacturer: '오비맥주', food_cd: 'N086', serving_size: 355, nutrition: { calories: 150, protein: 1, total_fat: 0, total_carbs: 10, total_sugars: 0, sodium: 10, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '처음처럼(소주)', manufacturer: '롯데칠성', food_cd: 'N087', serving_size: 50, nutrition: { calories: 60, protein: 0, total_fat: 0, total_carbs: 0, total_sugars: 0, sodium: 0, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},

  // 유지류
  { product_name: '올리브유(엑스트라버진)', manufacturer: 'CJ', food_cd: 'N088', serving_size: 15, nutrition: { calories: 120, protein: 0, total_fat: 14, total_carbs: 0, total_sugars: 0, sodium: 0, cholesterol: 0, saturated_fat: 2, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '참기름(식용유지)', manufacturer: '오뚜기', food_cd: 'N089', serving_size: 15, nutrition: { calories: 120, protein: 0, total_fat: 14, total_carbs: 0, total_sugars: 0, sodium: 0, cholesterol: 0, saturated_fat: 2.2, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '포도씨유(식용유지)', manufacturer: 'CJ', food_cd: 'N090', serving_size: 15, nutrition: { calories: 120, protein: 0, total_fat: 14, total_carbs: 0, total_sugars: 0, sodium: 0, cholesterol: 0, saturated_fat: 1.5, trans_fat: 0, dietary_fiber: 0 }},

  // 육가공
  { product_name: '뚝심 소시지(육가공)', manufacturer: '목우촌', food_cd: 'N091', serving_size: 60, nutrition: { calories: 170, protein: 8, total_fat: 14, total_carbs: 3, total_sugars: 1, sodium: 520, cholesterol: 35, saturated_fat: 5, trans_fat: 0.2, dietary_fiber: 0 }},
  { product_name: '맥스봉(소시지)', manufacturer: 'CJ', food_cd: 'N092', serving_size: 27, nutrition: { calories: 65, protein: 3, total_fat: 5, total_carbs: 2, total_sugars: 1, sodium: 210, cholesterol: 15, saturated_fat: 2, trans_fat: 0.1, dietary_fiber: 0 }},
  { product_name: '리얼햄(햄류)', manufacturer: '동원', food_cd: 'N093', serving_size: 30, nutrition: { calories: 50, protein: 5, total_fat: 3, total_carbs: 1, total_sugars: 0.5, sodium: 310, cholesterol: 15, saturated_fat: 1, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '더미식 닭가슴살', manufacturer: '하림', food_cd: 'N094', serving_size: 100, nutrition: { calories: 110, protein: 23, total_fat: 1.5, total_carbs: 1, total_sugars: 0, sodium: 450, cholesterol: 60, saturated_fat: 0.5, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '런천미트(캔햄)', manufacturer: '사조', food_cd: 'N095', serving_size: 60, nutrition: { calories: 185, protein: 7, total_fat: 16, total_carbs: 3, total_sugars: 1, sodium: 580, cholesterol: 30, saturated_fat: 6, trans_fat: 0.3, dietary_fiber: 0 }},

  // 수산가공
  { product_name: '참치캔 라이트(동원)', manufacturer: '동원', food_cd: 'N096', serving_size: 60, nutrition: { calories: 95, protein: 13, total_fat: 4.5, total_carbs: 0, total_sugars: 0, sodium: 200, cholesterol: 25, saturated_fat: 1, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '어묵바(수산)', manufacturer: '사조', food_cd: 'N097', serving_size: 70, nutrition: { calories: 85, protein: 6, total_fat: 2, total_carbs: 11, total_sugars: 3, sodium: 520, cholesterol: 15, saturated_fat: 0.5, trans_fat: 0, dietary_fiber: 0.5 }},
  { product_name: '참치마요(캔)', manufacturer: '오뚜기', food_cd: 'N098', serving_size: 50, nutrition: { calories: 150, protein: 7, total_fat: 12, total_carbs: 3, total_sugars: 1, sodium: 250, cholesterol: 20, saturated_fat: 2, trans_fat: 0, dietary_fiber: 0 }},

  // 두부/콩
  { product_name: '국산콩 두부(풀무원)', manufacturer: '풀무원', food_cd: 'N099', serving_size: 100, nutrition: { calories: 84, protein: 9, total_fat: 4.5, total_carbs: 2, total_sugars: 0.5, sodium: 5, cholesterol: 0, saturated_fat: 0.7, trans_fat: 0, dietary_fiber: 0.3 }},
  { product_name: '삼육 검은콩두유', manufacturer: '삼육식품', food_cd: 'N100', serving_size: 190, nutrition: { calories: 130, protein: 6, total_fat: 4, total_carbs: 17, total_sugars: 10, sodium: 105, cholesterol: 0, saturated_fat: 0.7, trans_fat: 0, dietary_fiber: 1 }},

  // 영양DB에만 있는 제품 5개 (바코드 없음)
  { product_name: '동원 참치 고추참치', manufacturer: '동원F&B', food_cd: 'N101', serving_size: 60, nutrition: { calories: 105, protein: 12, total_fat: 5.5, total_carbs: 2, total_sugars: 1, sodium: 280, cholesterol: 20, saturated_fat: 1.2, trans_fat: 0, dietary_fiber: 0 }},
  { product_name: '오뚜기 진미채볶음', manufacturer: '오뚜기', food_cd: 'N102', serving_size: 30, nutrition: { calories: 75, protein: 5, total_fat: 0.5, total_carbs: 13, total_sugars: 8, sodium: 350, cholesterol: 20, saturated_fat: 0.1, trans_fat: 0, dietary_fiber: 0.5 }},
  { product_name: '풀무원 유기농두유', manufacturer: '풀무원', food_cd: 'N103', serving_size: 190, nutrition: { calories: 120, protein: 7, total_fat: 4, total_carbs: 14, total_sugars: 8, sodium: 95, cholesterol: 0, saturated_fat: 0.5, trans_fat: 0, dietary_fiber: 1.5 }},
  { product_name: '비비고 수제 진한만두', manufacturer: 'CJ', food_cd: 'N104', serving_size: 120, nutrition: { calories: 260, protein: 10, total_fat: 10, total_carbs: 32, total_sugars: 3, sodium: 520, cholesterol: 25, saturated_fat: 3, trans_fat: 0.1, dietary_fiber: 2 }},
  { product_name: '삼양 까르보나라불닭', manufacturer: '삼양식품', food_cd: 'N105', serving_size: 140, nutrition: { calories: 550, protein: 9, total_fat: 18, total_carbs: 85, total_sugars: 6, sodium: 1650, cholesterol: 5, saturated_fat: 8, trans_fat: 0, dietary_fiber: 2 }},
];

module.exports = { c005Data, nutritionData };
