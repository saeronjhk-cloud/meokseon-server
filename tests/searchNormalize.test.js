/**
 * 검색어 정규화 단위 테스트
 *
 * Migration 009 의 SQL STORED 컬럼 규칙과 동치임을 보장.
 * 양쪽 규칙이 어긋나면 검색이 0건이 되므로 회귀 방지 필수.
 */

'use strict';

const assert = require('node:assert/strict');
const { test, describe } = require('node:test');
const { normalizeSearchQuery, isSearchable } = require('../src/utils/searchNormalize');

describe('normalizeSearchQuery', () => {
  test('공백 제거: "신 라면" → "신라면"', () => {
    assert.equal(normalizeSearchQuery('신 라면'), '신라면');
  });

  test('소문자 변환: "Coca-Cola" → "cocacola"', () => {
    assert.equal(normalizeSearchQuery('Coca-Cola'), 'cocacola');
  });

  test('한글 + 영문 + 숫자 보존: "신라면BLACK 120g" → "신라면black120g"', () => {
    assert.equal(normalizeSearchQuery('신라면BLACK 120g'), '신라면black120g');
  });

  test('특수문자 제거: "코카-콜라(제로)!" → "코카콜라제로"', () => {
    assert.equal(normalizeSearchQuery('코카-콜라(제로)!'), '코카콜라제로');
  });

  test('괄호·점 제거: "(주)농심" → "주농심"', () => {
    assert.equal(normalizeSearchQuery('(주)농심'), '주농심');
  });

  test('한자 제거 (현 단계 미지원): "肯德基" → ""', () => {
    // 한자는 후속 동의어 사전에서 처리 — 현재는 정규화 단계에서 제거
    assert.equal(normalizeSearchQuery('肯德基'), '');
  });

  test('한글 자모 보존: "ㅋㅋ" → "ㅋㅋ"', () => {
    assert.equal(normalizeSearchQuery('ㅋㅋ'), 'ㅋㅋ');
  });

  test('빈 입력 안전 처리', () => {
    assert.equal(normalizeSearchQuery(''), '');
    assert.equal(normalizeSearchQuery(null), '');
    assert.equal(normalizeSearchQuery(undefined), '');
    assert.equal(normalizeSearchQuery(123), '');
  });

  test('연속 공백 흡수: "농심    신라면" → "농심신라면"', () => {
    assert.equal(normalizeSearchQuery('농심    신라면'), '농심신라면');
  });

  test('이모지 제거: "신라면🍜" → "신라면"', () => {
    assert.equal(normalizeSearchQuery('신라면🍜'), '신라면');
  });
});

describe('isSearchable', () => {
  test('빈 문자열은 검색 불가', () => {
    assert.equal(isSearchable(''), false);
  });

  test('한글 1자 검색 허용', () => {
    assert.equal(isSearchable('차'), true);
  });

  test('영문 1자 검색 불가', () => {
    assert.equal(isSearchable('a'), false);
  });

  test('영문 2자 검색 허용', () => {
    assert.equal(isSearchable('ab'), true);
  });

  test('숫자 1자 검색 불가', () => {
    assert.equal(isSearchable('1'), false);
  });
});
