/**
 * gate-local.js — CI 게이트(`.github/workflows/gate.yml`)의 «regression» job 을
 *                 로컬에서 «같은 목록»으로 재현한다. (세션60 신설)
 * ============================================================================
 * 왜 생겼나 — 2026-08-10 세션60 실측
 *   커밋 `.bat` 의 회귀 목록(17개)과 `gate.yml` 의 목록이 **갈라져 있었다.**
 *   `gate.yml` 의 `npm run test:ocr` 안에 있는 `tests/test_paren_total_calories.js` 가
 *   커밋 게이트에는 **없었다.**
 *
 *   결과: 세션58 의 D55-2(원재료 추론 폐기)가 그 파일의 낡은 기대값과 충돌해
 *   `6e67532` 부터 CI 가 빨간불이 됐고, Railway 의 `Wait for CI` 가 배포를 SKIP 했다.
 *   ⇒ **세션56·57·58·59·60 이 한 줄도 운영에 가지 않았다.** 다섯 세션이다.
 *   ⇒ 그동안 `run-78-verify-deploy.bat` 은 초록이었다 — 78 은 **바코드 경로만** 치고,
 *     그 기능은 이미 배포돼 있던 `a0dfed3` 것이었기 때문이다.
 *
 * 그래서 이 파일은 «목록을 두 번 적지 않는다».
 *   `gate.yml` 을 **읽어서** 거기 적힌 명령을 그대로 돈다.
 *   ⇒ gate.yml 에 스텝을 추가하면 여기도 자동으로 늘어난다. 갈라질 수가 없다.
 *
 * 범위
 *   `regression` job 만 재현한다. `real-postgres` job 은 Docker·psql 이 필요해서
 *   로컬에서는 못 돈다 — **스킵했다고 «명시»한다.** 조용히 빼지 않는다.
 *
 * 사용
 *   node scripts/gate-local.js          전부 실행
 *   node scripts/gate-local.js --list   무엇을 돌지만 보여주고 끝낸다
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const YML = path.join(ROOT, '.github', 'workflows', 'gate.yml');
const LIST_ONLY = process.argv.includes('--list');

if (!fs.existsSync(YML)) {
  console.error('\n[중단] ' + YML + ' 가 없다. CI 게이트를 재현할 수 없다.\n');
  process.exit(2);
}

const lines = fs.readFileSync(YML, 'utf8').split('\n');

// ── regression job 의 범위를 찾는다 ──────────────────────────────────────────
//   YAML 파서를 쓰지 않는 이유: 의존성을 늘리지 않으려는 것이고,
//   여기서 보는 것은 「2칸 들여쓴 job 이름」과 「run: 한 줄」뿐이라 단순 스캔으로 충분하다.
let start = -1, end = lines.length;
for (let i = 0; i < lines.length; i++) {
  const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
  if (!m) continue;
  if (m[1] === 'regression') start = i;
  else if (start >= 0 && i > start) { end = i; break; }
}
if (start < 0) {
  console.error('\n[중단] gate.yml 에서 `regression` job 을 못 찾았다.');
  console.error('  job 이름이 바뀌었으면 이 스크립트도 고쳐야 한다.\n');
  process.exit(2);
}

// ── 한 줄짜리 `run:` 만 뽑는다 ───────────────────────────────────────────────
//   `run: |` (여러 줄 셸)은 psql·파일 배치 등 환경 의존이라 로컬에서 못 돈다.
//   ⚠ 조용히 빼지 않는다 — 아래에서 «스킵 목록»으로 찍는다.
const steps = [];
const skipped = [];
for (let i = start; i < end; i++) {
  const m = /^\s*run:\s*(.+?)\s*$/.exec(lines[i]);
  if (!m) continue;
  const cmd = m[1];
  // 직전의 `- name:` 을 라벨로 쓴다
  let label = cmd;
  for (let j = i - 1; j > start && j > i - 6; j--) {
    const n = /^\s*-\s*name:\s*(.+?)\s*$/.exec(lines[j]);
    if (n) { label = n[1].replace(/^["']|["']$/g, ''); break; }
  }
  if (cmd === '|') { skipped.push(label + '   (여러 줄 셸 — 환경 의존)'); continue; }
  if (/^npm ci\b/.test(cmd)) { skipped.push(label + '   (설치는 로컬에서 이미 돼 있다)'); continue; }
  steps.push({ label, cmd, line: i + 1 });
}

console.log('');
console.log('='.repeat(74));
console.log(' gate-local — CI 게이트(gate.yml · regression job) 로컬 재현');
console.log(' 목록은 gate.yml 에서 «읽어온» 것이다. 여기에 따로 적지 않는다.');
console.log('='.repeat(74));
console.log(' 실행 ' + steps.length + '건 · 스킵 ' + skipped.length + '건');
if (skipped.length) {
  console.log('\n ⚠ 로컬에서 못 도는 것 (조용히 빼지 않는다 — CI 에서는 돈다):');
  skipped.forEach((s) => console.log('    · ' + s));
}
console.log('\n ⚠ `real-postgres` job 은 통째로 스킵된다 (Docker + psql 필요).');
console.log('    pg_trgm · GENERATED 컬럼 · ALTER TYPE ADD VALUE · 진짜 PG 부팅은 CI 에서만 본다.');
console.log('');

if (LIST_ONLY) {
  steps.forEach((s, i) => console.log('  ' + String(i + 1).padStart(2) + '. ' + s.label + '\n      $ ' + s.cmd));
  console.log('');
  process.exit(0);
}

// ── 실행 ────────────────────────────────────────────────────────────────────
const failed = [];
for (let i = 0; i < steps.length; i++) {
  const s = steps[i];
  process.stdout.write('  [' + String(i + 1).padStart(2) + '/' + steps.length + '] ' + s.label.padEnd(46).slice(0, 46) + ' ');
  const r = spawnSync(s.cmd, {
    cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test' },
  });
  if (r.status === 0) {
    console.log('OK');
  } else {
    console.log('❌ FAIL (exit ' + r.status + ')');
    failed.push({ ...s, out: String(r.stdout || '') + String(r.stderr || '') });
  }
}

console.log('');
console.log('='.repeat(74));
if (failed.length === 0) {
  console.log(' ✅ regression job 전량 통과 — CI 가 이 커밋에서 초록일 «가능성이 높다».');
  console.log('    ⚠ 「높다」다. real-postgres job 은 여기서 안 돌았다.');
} else {
  console.log(' ❌ ' + failed.length + '건 실패 — 이 상태로 push 하면 **CI 가 빨간불이 되고**');
  console.log('    Railway `Wait for CI` 가 배포를 SKIP 한다. 커밋은 돼도 «운영에 안 간다».');
  console.log('');
  for (const f of failed) {
    console.log(' ── ' + f.label + '  (gate.yml:' + f.line + ')');
    console.log('    $ ' + f.cmd);
    const tail = f.out.trim().split('\n').slice(-14);
    tail.forEach((l) => console.log('    | ' + l));
    console.log('');
  }
}
console.log('='.repeat(74));
console.log('');
process.exit(failed.length ? 1 : 0);
