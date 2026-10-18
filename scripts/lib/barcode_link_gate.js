/**
 * barcode_link_gate.js — ★ 재수출 껍데기(세션81). 정본은 src/services/barcodeLinkGate.js.
 *   이유: 런타임(src/)이 scripts/ 를 require 하면 test_boot_graph §1 위반(운영 이미지 규칙) — 세션81 사용자 바코드 연결이 런타임에서 쓴다.
 *   스크립트(109·113·114)·테스트는 이 경로를 그대로 써도 같은 모듈을 받는다.
 */
'use strict';
module.exports = require('../../src/services/barcodeLinkGate');
