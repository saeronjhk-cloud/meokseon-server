'use strict';
/**
 * ★ 세션73 U71-5 — 제품명 제안 사전(products.product_name 토큰 빈도)을 DB 에서 만들어 메모리에 둔다.
 *   첫 요청 때 만들고(약 23만 행 · 수 초) 24시간 동안 재사용. 만드는 중 동시 요청은 같은 Promise 를 기다린다.
 *   ⛔ throw 하지 않는다 — 실패하면 null(제안 없이 종전 화면).
 */
const logger = require('../config/logger');
const { buildDictionary } = require('./nameSuggest');

const TTL_MS = 24 * 60 * 60 * 1000;
let cache = null; let builtAt = 0; let pending = null;

async function getDictionary(db, now = Date.now()) {
  if (cache && now - builtAt < TTL_MS) return cache;
  if (pending) return pending;
  pending = (async () => {
    try {
      const t0 = Date.now();
      const r = await db.query('SELECT product_name FROM products WHERE product_name IS NOT NULL');
      const dict = buildDictionary(r.rows.map((x) => x.product_name));
      cache = dict; builtAt = Date.now();
      logger.info('제품명 제안 사전 생성', { rows: r.rows.length, tokens: dict.freq.size, ms: Date.now() - t0 });
      return dict;
    } catch (e) {
      logger.warn('제품명 제안 사전 생성 실패 — 제안 생략', { error: e.message });
      return cache;   // 예전 사전이 있으면 그것을 쓴다(없으면 null)
    } finally { pending = null; }
  })();
  return pending;
}

function _reset() { cache = null; builtAt = 0; pending = null; }
module.exports = { getDictionary, _reset };
