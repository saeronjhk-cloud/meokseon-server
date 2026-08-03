#!/usr/bin/env node
'use strict';
/**
 * check-gate-yaml.js — .github/workflows/*.yml 이 GitHub Actions 에서 «로드되는지» 검사한다.
 *
 * ── 왜 별도 파일인가 (세션51에 실측으로 확인한 사고) ───────────────────────────
 * 세션50이 이 검사를 `run-commit-session50.bat` 안에 `node -e "..."` 한 줄로 넣었다.
 * 그 한 줄에는 문자 클래스 `[\"']` 가 들어 있었는데, **cmd.exe 는 `\"` 를 이스케이프로
 * 인정하지 않는다.** 백슬래시는 cmd 에게 아무 의미가 없고 `"` 는 그냥 인용을 «닫는다».
 * 인용이 닫힌 뒤에 나오는 `&&` 는 JS 연산자가 아니라 **cmd 의 명령 구분자**가 되어
 * 스크립트가 그 자리에서 잘린다. 실제로 세션51에 이렇게 터졌다:
 *
 *     SyntaxError: missing ) after argument list
 *     *** STOP: gate.yml would not load on GitHub Actions.
 *
 * 즉 **gate.yml 은 멀쩡한데 검사기가 죽으면서 커밋을 막았다.** 세션49의 「게이트가
 * 있다고 믿었는데 로드조차 안 됐다」와 방향만 반대인 같은 종류의 사고다.
 *   ⚠ 교훈: 인용부호·`&`·`|`·`^`·`%` 가 들어가는 검사는 **절대 .bat 안에 인라인으로
 *     쓰지 말 것.** 파일로 빼면 cmd 의 인용 규칙을 아예 통과하지 않는다.
 *
 * ── 무엇을 잡는가 ──────────────────────────────────────────────────────────
 * ① BARE_COLON  따옴표 없는 스칼라 안의 `: `(콜론+공백).
 *      `- name: test: allergen` → YAML 은 이것을 중첩 매핑으로 읽고 파싱에 실패한다.
 *      GitHub Actions 는 이런 워크플로를 **로드하지 않는다.** 실행 기록이 남지 않고
 *      Actions 탭에 아무것도 안 나오며 Railway 의 `Wait for CI` 도 인식하지 못한다.
 *      → 세션49가 `0d6f062` 로 push 한 gate.yml 이 정확히 이 상태였다(9개 스텝 이름).
 * ② TAB_INDENT  들여쓰기에 탭. YAML 명세가 금지한다.
 * ③ TRAILING_COLON  따옴표 없는 값이 `:` 로 끝나는 경우.
 * ④ UNCLOSED_QUOTE  한 줄 안에서 따옴표가 닫히지 않은 값.
 *
 * ── 무엇을 «못» 잡는가 (정직하게 적어 둔다) ─────────────────────────────────
 * 이 검사는 **어휘 검사이지 진짜 YAML 파서가 아니다.** 저장소에 `js-yaml`·`yaml`
 * 패키지가 설치돼 있지 않아 완전 파싱을 못 한다. 들여쓰기 구조 오류, 앵커/별칭 오류,
 * 중복 키 등은 통과한다. 진짜 파싱은 CI 의 첫 실행이 사실상의 검증이다.
 *   → 그러므로 이 검사가 초록이라고 「gate 가 돈다」로 읽지 말 것.
 *     **push 후 Actions 탭에 실행 기록이 «생겼는지»를 눈으로 확인해야 한다.**
 *
 * ── 블록 스칼라 처리 ───────────────────────────────────────────────────────
 * `run: |` 아래의 셸 스크립트에는 콜론이 얼마든지 들어간다. 그것까지 잡으면
 * 오탐이 폭발하므로, `|`·`>`(및 `-`/`+` 지시자) 뒤의 «더 깊게 들여쓴» 줄은 전부 건너뛴다.
 *
 * 사용:  node scripts/check-gate-yaml.js [파일...]
 *        인자가 없으면 .github/workflows/ 의 .yml·.yaml 전부를 검사한다.
 * 종료:  0 = 통과 / 1 = 위반 발견 / 2 = 검사 자체가 실패(파일 없음 등)
 */

const fs = require('fs');
const path = require('path');

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');

/** 인용부호 밖에서 시작하는 ` #` 주석을 잘라 낸다. */
function stripComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && i > 0 && /\s/.test(value[i - 1])) {
      return { text: value.slice(0, i).replace(/\s+$/, ''), openQuote: null };
    }
  }
  return { text: value.replace(/\s+$/, ''), openQuote: quote };
}

/** 한 파일을 검사해 위반 배열을 돌려준다. */
function checkFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/);
  const problems = [];

  // 블록 스칼라(`|`/`>`) 본문을 건너뛰기 위한 상태.
  let blockIndent = -1;

  let scanned = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const no = i + 1;

    if (line.trim() === '') continue;

    const indent = line.length - line.replace(/^[ \t]*/, '').length;

    // ── 블록 스칼라 본문이면 통째로 건너뛴다 ────────────────────────────────
    if (blockIndent >= 0) {
      if (indent > blockIndent) continue;
      blockIndent = -1;
    }

    // ② 들여쓰기 탭
    if (/^[ ]*\t/.test(line)) {
      problems.push({ no, line, code: 'TAB_INDENT', why: 'YAML forbids TAB in indentation' });
      continue;
    }

    const bare = line.replace(/^[ \t]*/, '');
    if (bare.startsWith('#')) continue;         // 주석 줄
    if (bare === '---' || bare === '...') continue;

    // `key: value` 또는 `- key: value` 형태만 본다. 값이 없는 `key:` 는 매핑 헤더다.
    const m = bare.match(/^(-\s+)?([^:#\s][^:]*):(\s.*|)$/);
    if (!m) continue;

    scanned++;
    const rest = m[3];

    if (rest.trim() === '') continue;           // `steps:` 처럼 값이 없는 줄

    const { text: value, openQuote } = stripComment(rest.trim());
    if (value === '') continue;

    // 블록 스칼라 시작 지시자: | > |- >- |+ >+ 그리고 명시 들여쓰기 숫자
    if (/^[|>][-+]?\d*$/.test(value)) {
      blockIndent = indent;
      continue;
    }

    // ④ 닫히지 않은 따옴표
    if (openQuote) {
      problems.push({ no, line, code: 'UNCLOSED_QUOTE', why: 'quote opened but never closed on this line' });
      continue;
    }

    // 따옴표로 감싼 값은 안전하다.
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value[value.length - 1] === q) continue;

    // 흐름 컬렉션은 이 검사의 범위 밖이다.
    if (q === '[' || q === '{' || q === '&' || q === '*') continue;

    // ① 따옴표 없는 스칼라 안의 콜론+공백  ← 세션49를 죽인 바로 그것
    if (/:\s/.test(value)) {
      problems.push({
        no, line, code: 'BARE_COLON',
        why: 'unquoted scalar contains ": " - YAML reads it as a nested mapping',
      });
      continue;
    }

    // ③ 따옴표 없는 값이 콜론으로 끝남
    if (/:$/.test(value)) {
      problems.push({ no, line, code: 'TRAILING_COLON', why: 'unquoted scalar ends with ":"' });
    }
  }

  return { problems, scanned };
}

function main() {
  let files = process.argv.slice(2);

  if (files.length === 0) {
    if (!fs.existsSync(WORKFLOW_DIR)) {
      console.error('*** check-gate-yaml: no .github/workflows directory at ' + WORKFLOW_DIR);
      process.exit(2);
    }
    files = fs.readdirSync(WORKFLOW_DIR)
      .filter((f) => /\.ya?ml$/i.test(f))
      .map((f) => path.join(WORKFLOW_DIR, f));
  }

  if (files.length === 0) {
    console.error('*** check-gate-yaml: no workflow files found. Expected at least gate.yml.');
    process.exit(2);
  }

  let bad = 0;
  let totalScanned = 0;

  for (const file of files) {
    const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');
    let result;
    try {
      result = checkFile(file);
    } catch (e) {
      console.error('*** check-gate-yaml: cannot read ' + rel + ' - ' + e.message);
      process.exit(2);
    }
    totalScanned += result.scanned;

    if (result.problems.length) {
      bad += result.problems.length;
      console.error('');
      console.error('*** ' + rel + ' would NOT load on GitHub Actions:');
      for (const p of result.problems) {
        console.error('      line ' + p.no + '  [' + p.code + ']  ' + p.why);
        console.error('        ' + p.line.trim());
      }
    }
  }

  if (bad) {
    console.error('');
    console.error('    Fix: wrap the value in double quotes.');
    console.error('         WRONG   - name: test: allergen');
    console.error('         RIGHT   - name: "test: allergen"');
    console.error('');
    console.error('    Why this matters: a workflow that does not parse is never loaded.');
    console.error('    The Actions tab shows nothing, no run is recorded, and Railway');
    console.error('    "Wait for CI" cannot see it. The gate silently does not exist.');
    process.exit(1);
  }

  console.log('gate.yml OK (' + files.length + ' workflow file(s), ' + totalScanned + ' key/value lines checked)');
  console.log('  NOTE: this is a lexical check, not a full YAML parse.');
  console.log('  After pushing, confirm the Actions tab actually shows a "gate" run.');
  process.exit(0);
}

main();
