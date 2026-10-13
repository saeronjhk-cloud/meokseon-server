/**
 * 103-kurly-label-crawl.js — 판매처(컬리) 현재 상품 → 상세 이미지 → Vision OCR → 품목보고번호 → 우리 DB 연결 여부  세션78 2026-10-13
 * ============================================================================
 * 역방향 파일럿 v1(60페이지)의 «수집» 단계를 규모로 돌리는 도구. DB 쓰기 없음(읽기만). 적재는 102 가 한다.
 *   1) 키워드별 컬리 검색 API(api.kurly.com/search/v4 … normal-search) → 상품 번호 수집(묶음·택1·세트·선물 제외 · 중복 제거)
 *   2) 상품 페이지의 상세 이미지(hdims/resize/%3E1010x 경로) → 폭 1200·높이 1800 조각(sharp 없이 python PIL: scripts/lib/split_tall_image.py)
 *   3) Vision OCR(src/services/ocrService · 운영과 같은 함수) → 품목보고번호(scripts/lib/report_no_gate.extractReportNosAll)
 *   4) public.products.c005_report_no 로 연결 여부만 판정(in_db / not_in_db / no_report_no / multi_report_no)
 * 출력: <out>/results.jsonl (한 줄 = 페이지 · 102 입력 형식) · <out>/ocr/rv_<상품번호>/ocr.txt (원문 · 102 가 다시 파싱)
 *   이미지 파일은 처리 후 지운다(OCR 원문만 남긴다 · 내부 처리용 · 서비스에 노출 안 함).
 * 재개: results.jsonl 에 있는 상품 번호는 건너뛴다. --max(기본 1000) 페이지 · Vision 호출 수를 끝에 출력.
 * 실행 (meokseon-server 폴더):
 *   node scripts/103-kurly-label-crawl.js --out ..\IP\web_label_crawl\run1 [--max 1000] [--per-keyword 96] [--keywords 과자,라면,…]
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const fs = require('fs'); const path = require('path'); const os = require('os'); const { execFileSync } = require('child_process');
const { callVisionAPI, correctOcrText } = require('../src/services/ocrService');
const { extractReportNosAll } = require('./lib/report_no_gate');

const DEFAULT_KW = ['과자', '라면', '우유', '아이스크림', '만두', '소스', '김치', '햄', '소시지', '음료', '커피', '두유', '빵', '시리얼', '초콜릿', '젤리', '요거트', '치즈', '즉석밥', '국', '카레', '참치', '김', '떡', '어묵', '견과', '차', '주스', '양념', '드레싱', '케첩', '마요네즈', '간장', '고추장', '된장', '식용유', '냉동피자', '돈까스', '스낵', '쿠키', '사탕', '껌', '탄산', '이온음료', '두부', '계란', '오리온', '농심', '오뚜기', '롯데웰푸드', '빙그레', '비비고', '백설', '동원', '삼립', '동서', '해태', '크라운', '풀무원', '대상', '청정원', '샘표', '매일유업', '남양', '서울우유', '하림', '사조', '팔도', '삼양', 'hy'];
const BAD = /택\s?\d|\d+종|세트|모음|골라|기획|증정|선물|체험|샘플|키트/;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const curl = (u, o) => execFileSync('curl', ['-s', '-A', 'Mozilla/5.0', '--max-time', '25', ...(o ? ['-o', o] : []), u], { maxBuffer: 64e6 }).toString();

async function main() {
  const OUT = path.resolve(arg('--out', path.join(__dirname, '..', '..', 'IP', 'web_label_crawl', 'run1'))); fs.mkdirSync(path.join(OUT, 'ocr'), { recursive: true });
  const MAX = +arg('--max', 1000); const PER = +arg('--per-keyword', 96); const KW = (arg('--keywords', '') || '').split(',').filter(Boolean); const kws = KW.length ? KW : DEFAULT_KW;
  const RES = path.join(OUT, 'results.jsonl'); const done = new Set(fs.existsSync(RES) ? fs.readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).no) : []);
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  // 1) 목록
  const listFile = path.join(OUT, 'list.json'); let list = fs.existsSync(listFile) ? JSON.parse(fs.readFileSync(listFile, 'utf8')) : null;
  if (!list) {
    const seen = new Set(); list = [];
    for (const k of kws) {
      try { const js = JSON.parse(curl('https://api.kurly.com/search/v4/sites/market/normal-search?keyword=' + encodeURIComponent(k) + `&page=1&per_page=${PER}`));
        const items = (((js.data && js.data.listSections) || []).find((s) => s.view && s.view.sectionCode === 'PRODUCT_LIST') || { data: { items: [] } }).data.items || [];
        for (const it of items) { if (seen.has(it.no) || BAD.test(it.name)) continue; seen.add(it.no); list.push({ kw: k, no: it.no, name: it.name }); }
      } catch (e) { console.error('검색 실패', k, e.message); }
    }
    fs.writeFileSync(listFile, JSON.stringify(list, null, 1)); console.log('목록', list.length);
  }
  // 2~4)
  const splitPy = path.join(__dirname, 'lib', 'split_tall_image.py'); let n = 0, calls = 0; const t0 = Date.now();
  for (const it of list) {
    if (n >= MAX) break; if (done.has(it.no)) continue; n++;
    const rec = { no: it.no, kw: it.kw, name: it.name, url: 'https://www.kurly.com/goods/' + it.no, at: new Date().toISOString(), vision_calls: 0 };
    const dir = path.join(OUT, 'ocr', 'rv_' + it.no); const tmp = path.join(os.tmpdir(), 'kurly_rv_' + it.no); fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(tmp, { recursive: true });   // 이미지는 OS 임시 폴더(작업 폴더에 남기지 않는다)
    try {
      const html = curl(rec.url).replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\\//g, '/');
      const imgs = [...new Set((html.match(/https:\/\/(?:img-cf|product-image)\.kurly\.com\/hdims\/resize\/%3E1010x\/[^"'\s<>)\\]*\.(?:jpg|jpeg|png)/g) || []).map((u) => u.replace(/hdims\/resize\/[^/]*\/quality\/\d+\/src\//, '')))].slice(0, 12);
      let text = '';
      for (const [k, u] of imgs.entries()) {
        const f = path.join(tmp, 'd' + k + path.extname(u)); try { curl(u, f); } catch (_) { continue; }
        const c = +execFileSync('python3', [splitPy, f, tmp]).toString().trim();
        for (let i = 0; i < Math.min(c, 8); i++) { const cf = path.join(tmp, path.basename(f) + '_' + String(i).padStart(2, '0') + '.jpg'); const r = await callVisionAPI(fs.readFileSync(cf).toString('base64')); rec.vision_calls++; calls++; text += '\n' + correctOcrText(r.full_text || '').corrected; }
      }
      fs.writeFileSync(path.join(dir, 'ocr.txt'), text); rec.images = imgs.length;
      const rns = extractReportNosAll(text); rec.report_nos = rns;
      if (!rns.length) rec.status = 'no_report_no'; else if (rns.length > 1) rec.status = 'multi_report_no';
      else { const c = await pool.query('select count(*)::int n from products where is_active and c005_report_no=$1', [rns[0]]); rec.db_products = c.rows[0].n; rec.status = c.rows[0].n ? 'in_db' : 'not_in_db'; }
    } catch (e) { rec.status = 'error'; rec.error = String(e.message).slice(0, 200); }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* */ }
    fs.appendFileSync(RES, JSON.stringify(rec) + '\n');
    if (n % 10 === 0) console.log(`${n}/${Math.min(MAX, list.length)} · Vision ${calls} · ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  console.log(`완료 ${n} 페이지 · Vision ${calls}회 · ${Math.round((Date.now() - t0) / 60000)}분 → ${RES}`);
  await pool.end();
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
