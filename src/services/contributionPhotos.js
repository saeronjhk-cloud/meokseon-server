/**
 * ★ 세션72f — 제보 라벨 사진 «축소본» 보관 (U69-1 해소 · 제이 결정 2026-09-30 · 보관 90일)
 *
 * 흐름:
 *   ① 앱이 `/api/ocr/multi-photo` 에 원본(OCR 용)과 함께 축소본(`label_archive`·`nutrition_archive`)을 보낸다.
 *   ② 저장하지 않는 분석이면 → `stash(analysisToken, photos)` : 메모리 15분 · 전체 64MB 상한.
 *      `/confirm` 이 저장에 성공하면 `take(token)` → `persist(...)` 로 DB 에 넣는다.
 *      save=true 로 바로 저장하는 구경로는 그 자리에서 `persist`.
 *   ③ 관리자만 `/api/admin/review/contributions/:productId/photos` · `/api/admin/photos/:photoId` 로 본다.
 *   ④ `purgeExpired` — 90일 지나고 대기(candidate) 없으면 삭제 · 365일은 무조건 삭제. 하루 한 번.
 *
 * 원칙:
 *   · ⛔ 사진 때문에 제보 저장이 실패하면 안 된다 — 여기의 모든 공개 함수는 throw 하지 않는다(로그만).
 *   · ⛔ 서버에서 이미지를 디코드·리사이즈하지 않는다(네이티브 모듈 금지). 크기·형식·매직바이트만 검사한다.
 *   · 030 미적용 DB 에서는 조용히 건너뛴다(배포 순서 방어 · to_regclass).
 */
const logger = require('../config/logger');

const MAX_PHOTO_BYTES = 1536 * 1024;          // 030 cp_size_chk 와 같은 값
const STASH_TTL_MS = 15 * 60 * 1000;          // analysisCache TTL(10분)보다 조금 길게
const STASH_BUDGET_BYTES = 64 * 1024 * 1024;  // 메모리 상한 — 넘치면 오래된 것부터 버린다
const RETAIN_DAYS = 90;
const HARD_RETAIN_DAYS = 365;
const KINDS = ['label', 'nutrition'];

function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** multer 파일 하나 → {kind, mime, bytes} 또는 null(사유 로그). 선언된 mimetype 이 아니라 «바이트»를 믿는다. */
function acceptArchive(kind, file) {
  if (!file || !KINDS.includes(kind)) return null;
  const buf = file.buffer;
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  if (buf.length > MAX_PHOTO_BYTES) {
    logger.warn('제보 사진 축소본 거부 — 너무 큼', { kind, bytes: buf.length });
    return null;
  }
  const mime = sniffMime(buf);
  if (!mime) {
    logger.warn('제보 사진 축소본 거부 — 이미지 아님', { kind });
    return null;
  }
  return { kind, mime, bytes: buf };
}

/**
 * ★ 켜짐 스위치 — `CONTRIBUTION_PHOTOS_ENABLED=true` 일 때만 보관한다(기본 꺼짐).
 *   개인정보처리방침에 «제보 사진 90일 보관»을 싣고 고지 기간이 지난 뒤 제이가 Railway 에서 켠다.
 *   꺼져 있으면 앱이 축소본을 보내도 받지 않는다(지금과 똑같이 메모리에서 버린다).
 */
function enabled(env = process.env) {
  return String(env.CONTRIBUTION_PHOTOS_ENABLED || '').trim().toLowerCase() === 'true';
}

/** req.files → 받아들인 축소본 배열(0~2). 스위치가 꺼져 있으면 []. */
function archivesFromRequest(files, env = process.env) {
  if (!enabled(env)) return [];
  const out = [];
  for (const kind of KINDS) {
    const f = files && files[`${kind}_archive`] && files[`${kind}_archive`][0];
    const a = acceptArchive(kind, f);
    if (a) out.push(a);
  }
  return out;
}

// ── 메모리 임시 보관 (확정 전) ──
const stashStore = new Map();   // token → { photos, bytes, expiresAt }
let stashBytes = 0;

function sweep(now = Date.now()) {
  for (const [k, v] of stashStore) {
    if (v.expiresAt <= now) { stashStore.delete(k); stashBytes -= v.bytes; }
  }
}

function stash(token, photos, now = Date.now()) {
  try {
    if (!token || !Array.isArray(photos) || photos.length === 0) return false;
    sweep(now);
    const bytes = photos.reduce((s, p) => s + p.bytes.length, 0);
    if (bytes > STASH_BUDGET_BYTES) return false;
    while (stashBytes + bytes > STASH_BUDGET_BYTES && stashStore.size) {
      const [k, v] = stashStore.entries().next().value;
      stashStore.delete(k); stashBytes -= v.bytes;
    }
    const prev = stashStore.get(token);
    if (prev) { stashStore.delete(token); stashBytes -= prev.bytes; }
    stashStore.set(token, { photos, bytes, expiresAt: now + STASH_TTL_MS });
    stashBytes += bytes;
    return true;
  } catch (e) {
    logger.warn('제보 사진 임시 보관 실패', { error: e.message });
    return false;
  }
}

/** 꺼내면서 지운다(한 번만 쓴다). */
function take(token, now = Date.now()) {
  if (!token) return [];
  sweep(now);
  const v = stashStore.get(token);
  if (!v) return [];
  stashStore.delete(token); stashBytes -= v.bytes;
  return v.photos;
}

async function tableReady(client) {
  const r = await client.query(`SELECT to_regclass('contribution_photos') IS NOT NULL AS ok`);
  return !!(r.rows[0] && r.rows[0].ok);
}

/** 확정된 제보의 사진을 DB 에 넣는다. @returns {Promise<number>} 넣은 장수 */
async function persist(client, { productId, photos }) {
  try {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || !Array.isArray(photos) || photos.length === 0) return 0;
    if (!(await tableReady(client))) {
      logger.warn('제보 사진 미보관 — 030 미적용', { productId: pid });
      return 0;
    }
    let n = 0;
    for (const p of photos) {
      await client.query(
        `INSERT INTO contribution_photos (product_id, kind, mime, byte_size, bytes)
         VALUES ($1, $2, $3, $4, $5)`,
        [pid, p.kind, p.mime, p.bytes.length, p.bytes]);
      n++;
    }
    logger.info('제보 사진 보관', { productId: pid, count: n });
    return n;
  } catch (e) {
    logger.warn('제보 사진 보관 실패', { productId, error: e.message });
    return 0;
  }
}

/** 관리자 목록 — 바이트는 내보내지 않는다(한 장씩 getPhoto). 사진은 사람(user_id)에 묶지 않는다(030). */
async function listForProduct(client, productId) {
  const pid = Number(productId);
  if (!Number.isFinite(pid)) return [];
  if (!(await tableReady(client))) return [];
  const r = await client.query(
    `SELECT photo_id, kind, mime, byte_size, created_at FROM contribution_photos
      WHERE product_id = $1 ORDER BY created_at DESC, photo_id DESC LIMIT 20`, [pid]);
  return r.rows.map((x) => ({
    photo_id: Number(x.photo_id), kind: x.kind, mime: x.mime, byte_size: Number(x.byte_size), created_at: x.created_at,
  }));
}

async function getPhoto(client, photoId) {
  const id = Number(photoId);
  if (!Number.isFinite(id)) return null;
  if (!(await tableReady(client))) return null;
  const r = await client.query(`SELECT mime, bytes FROM contribution_photos WHERE photo_id = $1`, [id]);
  if (!r.rows.length) return null;
  const b = r.rows[0].bytes;
  return { mime: r.rows[0].mime, bytes: Buffer.isBuffer(b) ? b : Buffer.from(b) };
}

/** 파기. @returns {Promise<number>} 지운 장수 */
async function purgeExpired(client, opts = {}) {
  const days = Number(opts.days) > 0 ? Number(opts.days) : RETAIN_DAYS;
  const hard = Number(opts.hardDays) > 0 ? Number(opts.hardDays) : HARD_RETAIN_DAYS;
  try {
    if (!(await tableReady(client))) return 0;
    const hasReview = !!(await client.query(`SELECT to_regclass('contribution_review') IS NOT NULL AS ok`)).rows[0].ok;
    const r = await client.query(
      `DELETE FROM contribution_photos cp
        WHERE cp.created_at < NOW() - make_interval(days => $2::int)
           OR (cp.created_at < NOW() - make_interval(days => $1::int)
               ${hasReview ? `AND NOT EXISTS (SELECT 1 FROM contribution_review cr
                                               WHERE cr.product_id = cp.product_id AND cr.status = 'candidate')` : ''})`,
      [days, hard]);
    const n = (r && (r.rowCount ?? r.affectedRows)) || 0;
    if (n) logger.info('제보 사진 파기', { count: n, days, hardDays: hard });
    return n;
  } catch (e) {
    logger.warn('제보 사진 파기 실패', { error: e.message });
    return 0;
  }
}

/** 하루 한 번 파기(부팅 1분 뒤 첫 실행). 타이머는 unref — 종료를 막지 않는다. */
function startPurgeTimer(db, intervalMs = 24 * 60 * 60 * 1000) {
  const run = () => { purgeExpired(db).catch(() => {}); };
  const t1 = setTimeout(run, 60 * 1000); if (t1.unref) t1.unref();
  const t2 = setInterval(run, intervalMs); if (t2.unref) t2.unref();
  return { stop: () => { clearTimeout(t1); clearInterval(t2); } };
}

module.exports = {
  MAX_PHOTO_BYTES, RETAIN_DAYS, HARD_RETAIN_DAYS, STASH_TTL_MS,
  enabled, sniffMime, acceptArchive, archivesFromRequest, stash, take, persist,
  listForProduct, getPhoto, purgeExpired, startPurgeTimer,
  _stashState: () => ({ size: stashStore.size, bytes: stashBytes }),
};
