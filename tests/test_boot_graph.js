/**
 * test_boot_graph.js — 세션66 (2026-09-01) 「배포되면 부팅되는가」 회귀
 * ============================================================================
 * 왜 생겼나 — **같은 파일 하나가 배포를 두 번 죽였다.**
 *
 *   ① CI (gate #22) — `src/routes/adminRoutes.js` 가
 *      `require('../../scripts/staging/off/collapse_classify')` 를 했는데
 *      그 파일이 **git 미추적**이었다. 체크아웃에 없으니 `MODULE_NOT_FOUND`,
 *      「앱이 부팅되는가」 스텝에서 **세 job 이 전부 빨강**.
 *
 *   ② Railway — git 에 넣어 고쳤더니 이번엔 **`.dockerignore` 가 `scripts/staging/` 을
 *      통째로 제외**했다(「일회성 데이터 파이프라인 스크립트 — 운영엔 불필요」. 의도된 배제다).
 *      이미지 안에 파일이 없어 컨테이너가 부팅 즉시 죽고 **크래시 루프 → healthcheck 실패**.
 *      ⚠⚠ **로그에 에러가 «한 줄도» 안 남았다.** `injected env (0)` 만 반복됐다.
 *         원인을 찾는 데 왕복이 여러 번 들었다.
 *
 * ⇒ 두 사고의 뿌리는 하나다: **`src/`(런타임)가 `scripts/`(배치)를 require 했다.**
 *   둘은 **배포 경계가 다르다** — `scripts/staging/`·`scripts/merge/` 는 이미지에 «일부러» 안 들어간다.
 *
 * 무엇을 지키는가
 *   §1 ★ 부팅 그래프(= `src/app.js` 가 실제로 로드하는 저장소 내부 파일)가 **`src/` 안에서 닫힌다.**
 *       → `scripts/`·`week1_pipeline/`·`data/` 등 배포에서 빠지는 곳을 런타임이 못 끌어 쓴다.
 *   §2 ★ 부팅 그래프의 모든 파일이 **git 에 추적된다.** (① 재발 방지)
 *   §3 ★ 부팅 그래프의 어떤 파일도 **`.dockerignore` 에 걸리지 않는다.** (② 재발 방지)
 *   §4 `collapse_classify` 껍데기가 정본을 **그대로** 재수출한다(로직 두 벌 방지).
 *
 * ★ 왜 「소스 문자열 grep」이 아니라 «실제 로드»인가
 *   정적 grep 은 조건부 require·동적 경로를 놓친다. 여기서는 `Module._resolveFilename` 을
 *   후킹해 **진짜로 로드된 것만** 모은다. 세션66 이 원인을 찾을 때 쓴 그 방법이다.
 *
 * ⚠ 이 테스트가 «못» 잡는 것 — 정직하게 적는다
 *   · 부팅 «후»에 lazy require 되는 모듈(요청 처리 중 `require`)은 그래프에 안 잡힌다.
 *   · `.dockerignore` 매처는 이 저장소가 실제로 쓰는 형태(디렉터리 접두 · `*.ext` · `!부정`)만 다룬다.
 *     완전한 Docker 패턴 구현이 아니다. 애매하면 «걸린다»고 보수적으로 판정한다.
 *
 * 실행: cross-env NODE_ENV=test node tests/test_boot_graph.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRV = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, message: e.stack || e.message });
    console.log(`  ❌ ${name}\n     → ${e.message}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

// ── 부팅 그래프 수집 ─────────────────────────────────────────────────────────
// `src/app.js` 를 실제로 require 하면서 «저장소 내부» 파일만 모은다.
// node_modules 는 배포 이미지가 `npm install` 로 따로 만드므로 대상이 아니다.
function collectBootGraph() {
  const Module = require('module');
  const seen = new Set();
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (req, ...rest) {
    const f = orig.call(this, req, ...rest);
    if (typeof f === 'string' && f.startsWith(SRV) && !f.includes('node_modules')) {
      seen.add(path.relative(SRV, f).split(path.sep).join('/'));
    }
    return f;
  };
  try {
    require(path.join(SRV, 'src/app.js'));
  } finally {
    Module._resolveFilename = orig;
  }
  return [...seen].sort();
}

// ── .dockerignore 매처 (이 저장소가 실제로 쓰는 형태만) ──────────────────────
function parseDockerignore(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function dockerignoreVerdict(rel, patterns) {
  let ignored = false;
  let by = null;
  for (const raw of patterns) {
    const neg = raw.startsWith('!');
    const pat = neg ? raw.slice(1) : raw;
    let hit = false;

    if (pat.endsWith('/')) {
      // 디렉터리 접두 — `scripts/staging/` 이 정확히 이 형태다
      hit = rel === pat.slice(0, -1) || rel.startsWith(pat);
    } else if (pat.includes('*')) {
      // `*.log` · `*backup*.sql` 류. 경로 구분자는 넘지 않는다.
      const rx = new RegExp('^' + pat.split('*').map(escapeRe).join('[^/]*') + '$');
      hit = rx.test(rel) || rx.test(path.basename(rel));
    } else {
      hit = rel === pat || rel.startsWith(pat + '/');
    }

    if (hit) {
      ignored = !neg;
      by = raw;
    }
  }
  return { ignored, by };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function gitTracked(rel) {
  try {
    // ⚠ 읽기 전용 git 만 쓴다. `git status`·`add` 는 인덱스 lock 을 만든다(세션64 사고).
    execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: SRV, stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(' test_boot_graph — 배포되면 부팅되는가 (세션66)');
  console.log('════════════════════════════════════════════════════════════════');

  const graph = collectBootGraph();
  console.log(`\n부팅 그래프: 저장소 내부 파일 ${graph.length}개`);
  assert.ok(graph.length > 10, `그래프가 비정상적으로 작다(${graph.length}) — 후킹이 안 먹었을 수 있다`);

  section('§1 ★ 런타임이 src/ 안에서 닫혀 있는가');
  await t('§1 부팅 그래프의 모든 파일이 src/ 아래에 있다', () => {
    const outside = graph.filter((f) => !f.startsWith('src/'));
    assert.deepStrictEqual(
      outside, [],
      '★ `src/`(런타임)가 그 밖을 require 한다: ' + outside.join(', ')
      + '\n   `scripts/staging/`·`scripts/merge/`·`week1_pipeline/` 등은 `.dockerignore` 가 «의도적으로» 제외한다.'
      + '\n   → 운영 컨테이너에 그 파일이 «없어서» 부팅 즉시 죽고, 로그에 에러가 한 줄도 안 남는다.'
      + '\n   ⇒ 필요한 로직은 `src/` 로 «옮기고», 원래 자리는 재수출 껍데기로 둘 것'
      + '\n     (본보기: `src/services/collapseClassify.js` ← `scripts/staging/off/collapse_classify.js`).'
      + '\n   ⛔ `.dockerignore` 를 뚫는 것은 오답이다 — 일회성 스크립트가 운영 이미지에 들어간다.',
    );
  });

  section('§2 ★ 부팅에 필요한 파일이 전부 git 에 있는가 (gate #22 재발 방지)');
  await t('§2 부팅 그래프의 모든 파일이 git 추적 대상이다', () => {
    const untracked = graph.filter((f) => !gitTracked(f));
    assert.deepStrictEqual(
      untracked, [],
      '★ 부팅에 필요한데 git 에 없다: ' + untracked.join(', ')
      + '\n   CI 체크아웃·배포 아카이브에 안 들어가므로 `MODULE_NOT_FOUND` 로 앱이 안 뜬다.'
      + '\n   ⚠ 로컬에서는 파일이 «있어서» 절대 안 잡힌다. 그래서 이 단정이 필요하다.',
    );
  });

  section('§3 ★ 부팅에 필요한 파일이 Docker 이미지에 들어가는가 (Railway 사고 재발 방지)');
  await t('§3 부팅 그래프의 어떤 파일도 .dockerignore 에 걸리지 않는다', () => {
    const dockerignorePath = path.join(SRV, '.dockerignore');
    assert.ok(fs.existsSync(dockerignorePath), '.dockerignore 가 없다 — 이 검사의 전제가 무너졌다');
    const patterns = parseDockerignore(fs.readFileSync(dockerignorePath, 'utf8'));

    const blocked = [];
    for (const f of graph) {
      const v = dockerignoreVerdict(f, patterns);
      if (v.ignored) blocked.push(`${f} (패턴: ${v.by})`);
    }
    assert.deepStrictEqual(
      blocked, [],
      '★ 부팅에 필요한데 Docker 이미지에서 «제외»된다: ' + blocked.join(', ')
      + '\n   컨테이너 안에 파일이 없어 부팅 즉시 죽는다 = 크래시 루프 + healthcheck 실패.'
      + '\n   ⚠⚠ 이때 Railway 로그에는 «에러가 한 줄도 남지 않는다**(`injected env (0)` 만 반복).'
      + '\n   ⇒ 로직을 `src/` 로 옮길 것. `.dockerignore` 에 예외(`!`)를 추가하는 것은 오답이다.',
    );
  });

  await t('§3-b 매처 자기검사 — scripts/staging/ 이 실제로 «걸리는» 것으로 판정된다', () => {
    const patterns = parseDockerignore(fs.readFileSync(path.join(SRV, '.dockerignore'), 'utf8'));
    // 이 단정이 없으면 매처가 «전부 통과»로 망가져도 §3 이 조용히 초록이 된다.
    assert.strictEqual(
      dockerignoreVerdict('scripts/staging/off/collapse_classify.js', patterns).ignored, true,
      '매처가 `scripts/staging/` 을 못 잡는다 — §3 이 거짓 초록이다',
    );
    assert.strictEqual(
      dockerignoreVerdict('src/services/collapseClassify.js', patterns).ignored, false,
      '매처가 `src/` 를 잘못 잡는다 — §3 이 거짓 빨강이다',
    );
    assert.strictEqual(
      dockerignoreVerdict('tests/test_boot_graph.js', patterns).ignored, true,
      '매처가 `tests/` 를 못 잡는다',
    );
  });

  section('§4 재수출 껍데기가 정본과 «같은 것»인가');
  await t('§4 scripts 쪽 collapse_classify 가 src 정본을 그대로 재수출한다', () => {
    const shim = require(path.join(SRV, 'scripts/staging/off/collapse_classify'));
    const canon = require(path.join(SRV, 'src/services/collapseClassify'));
    assert.strictEqual(shim, canon, '껍데기가 정본과 다른 객체다 — 로직이 두 벌이 됐을 수 있다');
    for (const k of ['collapseClassify', 'verifyEligibility', 'isSuppressedRoute', 'alignBasis',
      'axisConflict', 'isMissingZero', 'parseServingG', 'SUPPRESSED_ROUTES', 'VERSION']) {
      assert.ok(k in canon, `export 가 빠졌다: ${k} — 배치 스크립트 4개가 이것을 쓴다`);
    }
  });

  await t('§4-b 판정 규칙이 안 바뀌었다 (옮기면서 로직을 건드리지 않았다)', () => {
    const { verifyEligibility, isSuppressedRoute, parseServingG } =
      require(path.join(SRV, 'src/services/collapseClassify'));
    // 단일후보 함정 HARD RULE — 일반명사 + 보강근거 0 → 승격 불가
    assert.deepStrictEqual(
      verifyEligibility({ is_generic: true, corroboration: [] }),
      { eligible: false, reason: 'generic_name_no_corroboration' });
    assert.deepStrictEqual(
      verifyEligibility({ is_generic: true, corroboration: ['brand'] }),
      { eligible: true, reason: null });
    assert.strictEqual(isSuppressedRoute('conflict_unresolvable'), true);
    assert.strictEqual(isSuppressedRoute('needs_review'), false);
    // per_serving 은 g/ml 이 확실할 때만 — '1개'는 null
    assert.strictEqual(parseServingG('30g'), 30);
    assert.strictEqual(parseServingG('1개'), null);
  });

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(` 통과 ${pass} · 실패 ${fail}`);
  if (fail > 0) {
    console.log('\n실패 상세:');
    for (const f of failures) console.log(`\n[${f.name}]\n${f.message}`);
  }
  console.log('════════════════════════════════════════════════════════════════\n');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
