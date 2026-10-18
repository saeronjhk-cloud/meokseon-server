/**
 * barcodeLinkRoutes.js — ★ 세션81 «사용자 바코드 연결» /api/barcode-links (로그인 필수 · 제보와 같은 원칙 «제보도 로그인 필수»)
 *   POST /            { barcode, food_cd } → 제보 저장 + 판정. personal/auto 면 응답에 K-FIND 상품 본문(getKfindProduct).
 *   GET  /mine/:barcode → 본인 personal 연결의 상품 본문 · 없으면 404(남의 제보는 보이지 않는다).
 *   정답 IP/eval_user_barcode_v1 UR01~06.
 *   ⚠ 공개 스캔 경로(GET /api/products/:barcode)는 바꾸지 않는다 — auto 가 되면 세션80 kfind 폴백이 그대로 낸다(UR03).
 */
'use strict';
const express = require('express');
const { supabaseAuth } = require('../middleware/supabaseAuth');
const { findUserId, getOrCreateUserId, handleStoreNotReady } = require('../services/authUserService');
const svc = require('../services/userBarcodeLinkService');
const productService = require('../services/productService');

const router = express.Router();
const FOOD_CD_RE = /^P\d{3}-\d{9}-\d{4}$/;   // 80b GET /kfind/:foodCd 와 같은 형식
const bad = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });

router.post('/', supabaseAuth, async (req, res, next) => {
  const { barcode, food_cd: foodCd } = req.body || {};
  if (typeof foodCd !== 'string' || !FOOD_CD_RE.test(foodCd)) return bad(res, 400, 'FOOD_CD_INVALID', '제품 번호가 올바르지 않아요.');
  if (typeof barcode !== 'string' && typeof barcode !== 'number') return bad(res, 400, 'BARCODE_INVALID', '바코드 숫자가 올바르지 않아요.');
  try {
    const userId = await getOrCreateUserId(req.auth);
    const r = await svc.submitClaim({ userId, barcode: String(barcode), foodCd, source: 'user' });
    let product = null;
    if (r.personal || r.verdict === 'auto') product = await productService.getKfindProduct(foodCd).catch(() => null);
    return res.json({ success: true, data: { ...r, product } });
  } catch (err) {
    if (err instanceof svc.LinkError) return bad(res, err.status, err.code, err.message);
    if (handleStoreNotReady(err, res)) return;
    return next(err);
  }
});

router.get('/mine/:barcode', supabaseAuth, async (req, res, next) => {
  try {
    const userId = await findUserId(req.auth.supabaseUid);
    const link = userId === null ? null : await svc.findMyLink(userId, req.params.barcode);
    if (!link) return bad(res, 404, 'LINK_NOT_FOUND', '연결한 제품이 없어요.');
    const product = await productService.getKfindProduct(link.food_cd);
    return res.json({ success: true, data: { ...link, product } });
  } catch (err) {
    if (handleStoreNotReady(err, res)) return;
    return next(err);
  }
});

module.exports = router;
