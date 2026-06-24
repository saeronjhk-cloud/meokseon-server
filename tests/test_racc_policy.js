/**
 * RACC 정책 v1.4 평가셋 (16케이스) — IP/eval_set/eval_set_racc_v1.md
 * 소량섭취 면제 + 3 농축가드(나트륨·당류·지방) + 대조군 무회귀.
 */
const { evaluateNutrition } = require('../src/services/nutritionTrafficLight');
let pass=0, fail=0;
function chk(cond, name){ console.log((cond?'  ✅ ':'  ❌ ')+name); cond?pass++:fail++; }
function color(p, n, racc){ return evaluateNutrition(p, n, undefined, racc).nutrients; }

// 공통: per-100g 데이터
const P100 = (extra={}) => Object.assign({ basis:'per_100g' }, extra);

console.log('\n[A] 소량 고농축 (면제 + 농축가드)');
// 1 참기름 oil
let r = color({product_name:'참기름',food_type:'참기름',content_unit:'g'}, P100({total_fat:100,sat_fat:16}), {racc:5,exempt:true,guards:['oil']});
chk(r.total_fat.color==='yellow' && r.sat_fat.color==='yellow', '1 참기름 지방 Green금지→Y');
// 2 간장
r = color({product_name:'간장',food_type:'혼합장',content_unit:'g'}, P100({sodium:5800}), {racc:10,exempt:true,guards:['sodium']});
chk(r.sodium.color==='red', '2 간장 나트륨 29%DV→R');
// 3 고추장
r = color({product_name:'고추장',food_type:'고추장',content_unit:'g'}, P100({sodium:2800,sugars:35}), {racc:10,exempt:true,guards:['sodium','sugar']});
chk(r.sodium.color==='yellow' && r.sugars.color==='yellow', '3 고추장 나트륨14%→Y, 당 floor Y');
// 4 된장
r = color({product_name:'된장',food_type:'된장',content_unit:'g'}, P100({sodium:4500}), {racc:10,exempt:true,guards:['sodium']});
chk(r.sodium.color==='red', '4 된장 나트륨 22.5%DV→R');
// 5 마요네즈 oil
r = color({product_name:'마요네즈',food_type:'소스',content_unit:'g'}, P100({total_fat:75,sat_fat:8}), {racc:10,exempt:true,guards:['oil']});
chk(r.total_fat.color==='yellow' && r.sat_fat.color==='yellow', '5 마요 지방 Green금지→Y');
// 6 소스(드레싱)
r = color({product_name:'드레싱',food_type:'소스',content_unit:'g'}, P100({sodium:1200,sugars:20}), {racc:15,exempt:true,guards:['sodium','sugar']});
chk(r.sodium.color==='yellow' && r.sugars.color==='yellow', '6 소스 나트륨9%→Y, 당 floor Y');
// 7 조미김
r = color({product_name:'조미김',food_type:'조미김',content_unit:'g'}, P100({sodium:600}), {racc:4,exempt:true,guards:['sodium']});
chk(r.sodium.color==='yellow', '7 조미김 나트륨 floor→Y (초록 금지)');
// 8 젓갈 imputed
r = color({product_name:'명란젓',food_type:'젓갈',content_unit:'g'}, P100({sodium:4000}), {racc:15,exempt:true,guards:['sodium']});
chk(r.sodium.color==='red', '8 젓갈(imputed15) 나트륨 30%DV→R');
// 9 식초
r = color({product_name:'식초',food_type:'발효식초',content_unit:'ml'}, P100({sodium:5,sugars:2}), {racc:5,exempt:true,guards:[]});
chk(r.sodium.color==='green' && r.sugars.color==='green', '9 식초 면제 후 대부분 G');
// 10 참기름 저포화
r = color({product_name:'참기름',food_type:'참기름',content_unit:'g'}, P100({total_fat:100,sat_fat:1}), {racc:5,exempt:true,guards:['oil']});
chk(r.total_fat.color==='yellow' && r.sat_fat.color==='yellow', '10 참기름 저포화도 oil가드 Y');
// 11 당류가공품
r = color({product_name:'시럽',food_type:'당류가공품',content_unit:'g'}, P100({sugars:80}), {racc:10,exempt:true,guards:['sugar']});
chk(r.sugars.color==='yellow', '11 당류가공품 당 8%→floor Y');

console.log('\n[B] 대조군 (비면제 — 무회귀)');
// 12 과자
r = color({product_name:'감자칩',food_type:'과자',content_unit:'g',serving_size:30}, P100({sodium:600,sat_fat:8}), null);
chk(r.sodium.color==='yellow' && r.sat_fat.color==='red', '12 과자 Na Y · 포화 R (기존)');
// 13 초콜릿
r = color({product_name:'초콜릿',food_type:'초콜릿가공품',content_unit:'g',serving_size:30}, P100({sugars:50,sat_fat:18}), null);
chk(r.sugars.color==='red' && r.sat_fat.color==='red', '13 초콜릿 당 R · 포화 R');
// 14 소시지
r = color({product_name:'소시지',food_type:'소시지',content_unit:'g',serving_size:30}, P100({sodium:1000,sat_fat:9}), null);
chk(r.sodium.color==='red' && r.sat_fat.color==='red', '14 소시지 Na R · 포화 R');
// 15 김치
r = color({product_name:'배추김치',food_type:'김치',content_unit:'g',serving_size:40}, P100({sodium:850}), null);
chk(r.sodium.color==='red', '15 김치 나트륨 R');
// 16 탄산음료
r = color({product_name:'콜라',food_type:'탄산음료',content_unit:'ml',serving_size:200}, {basis:'per_100ml',sugars:11}, null);
chk(r.sugars.color==='red', '16 탄산음료 당 R (per-100ml)');

console.log(`\n${'='.repeat(46)}`);
console.log(`📊 RACC 평가셋: ${pass} 통과 / ${fail} 실패 (총 ${pass+fail})`);
if(fail>0) process.exit(1);
