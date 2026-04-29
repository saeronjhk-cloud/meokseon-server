/**
 * Swagger / OpenAPI 3.0 문서 정의
 */

const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: '먹선(吃選) API',
    version: '1.0.0',
    description: '식품 안전 정보 플랫폼 — 영양 신호등 + 첨가물 위해성 분석 API',
    contact: {
      name: 'Jay Kim',
      email: 'saeronjhk@gmail.com',
    },
  },
  servers: [
    { url: '/api', description: 'API Base' },
  ],
  tags: [
    { name: 'Products', description: '제품 조회 및 검색' },
    { name: 'Evaluation', description: '영양 신호등 판정' },
    { name: 'OCR', description: '식품 라벨 OCR 분석' },
    { name: 'System', description: '시스템 상태' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: '서버 헬스체크',
        responses: {
          200: { description: '정상', content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } } },
          503: { description: 'DB 연결 실패' },
        },
      },
    },
    '/products/search': {
      get: {
        tags: ['Products'],
        summary: '제품명 퍼지 검색',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: '검색어', example: '새우깡' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          200: { description: '검색 결과', content: { 'application/json': { schema: { $ref: '#/components/schemas/SearchResponse' } } } },
          400: { description: '검색어 미입력' },
        },
      },
    },
    '/products/recent': {
      get: {
        tags: ['Products'],
        summary: '최근 등록 제품 목록',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 50 } },
        ],
        responses: {
          200: { description: '최근 제품 목록' },
        },
      },
    },
    '/products/{barcode}': {
      get: {
        tags: ['Products'],
        summary: '바코드로 제품 조회 + 영양 신호등 판정',
        parameters: [
          { name: 'barcode', in: 'path', required: true, schema: { type: 'string', pattern: '^\\d{8,14}$' }, example: '8801043012607' },
        ],
        responses: {
          200: { description: '제품 정보 + 영양 판정', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProductDetailResponse' } } } },
          404: { description: '제품을 찾을 수 없음' },
        },
      },
    },
    '/products/{barcode}/additives': {
      get: {
        tags: ['Products'],
        summary: '제품 첨가물 목록 + 위해성 조회',
        parameters: [
          { name: 'barcode', in: 'path', required: true, schema: { type: 'string', pattern: '^\\d{8,14}$' } },
        ],
        responses: {
          200: { description: '첨가물 목록 + 위해성 요약' },
          404: { description: '제품을 찾을 수 없음' },
        },
      },
    },
    '/products/evaluate': {
      post: {
        tags: ['Evaluation'],
        summary: '수동 영양 신호등 판정 (DB 미사용)',
        description: 'OCR 결과 등을 직접 전달하여 영양 신호등 판정을 받습니다.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/EvaluateRequest' },
              example: {
                product: {
                  product_name: '새우깡',
                  food_type: '과자',
                  content_unit: 'g',
                  serving_size: 30,
                  total_content: 90,
                },
                nutrition: {
                  calories: 140, sodium: 200, sugars: 2,
                  sat_fat: 1.5, total_fat: 7, cholesterol: 5,
                  protein: 2, fiber: 0.5, trans_fat: 0,
                },
              },
            },
          },
        },
        responses: {
          200: { description: '판정 결과 + OCR 경고' },
          400: { description: '입력값 오류' },
        },
      },
    },
    '/ocr/analyze': {
      post: {
        tags: ['OCR'],
        summary: '식품 라벨 OCR 전체 분석 (E2E)',
        description: 'base64 이미지 → OCR → 원재료 파싱 → 첨가물 식별 → 영양 신호등 판정까지 한 번에 처리합니다.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OcrAnalyzeRequest' },
            },
          },
        },
        responses: {
          200: { description: 'OCR 분석 결과 + 신호등 판정' },
          400: { description: '이미지 누락 또는 형식 오류' },
        },
      },
    },
    '/ocr/text-only': {
      post: {
        tags: ['OCR'],
        summary: 'OCR 텍스트만 추출',
        description: '이미지에서 텍스트만 추출합니다 (분석 없이).',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['image'],
                properties: {
                  image: { type: 'string', description: 'base64 인코딩된 이미지' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: '추출된 텍스트' },
          400: { description: '이미지 누락' },
        },
      },
    },
  },
  components: {
    schemas: {
      HealthResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            type: 'object',
            properties: {
              service: { type: 'string' },
              version: { type: 'string' },
              uptime: { type: 'integer' },
              database: { type: 'object' },
            },
          },
        },
      },
      SearchResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              count: { type: 'integer' },
              products: { type: 'array', items: { $ref: '#/components/schemas/ProductSummary' } },
            },
          },
        },
      },
      ProductSummary: {
        type: 'object',
        properties: {
          product_id: { type: 'integer' },
          barcode: { type: 'string' },
          product_name: { type: 'string' },
          manufacturer: { type: 'string' },
          food_category: { type: 'string', enum: ['general', 'beverage', 'dried', 'fermented', 'alcohol', 'supplement', 'raw_ingredient'] },
          score: { type: 'number', description: 'trigram 유사도 점수 (검색 시)' },
        },
      },
      ProductDetailResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            type: 'object',
            properties: {
              product: { $ref: '#/components/schemas/ProductSummary' },
              nutrition: { type: 'object', description: '영양성분 상세' },
              traffic_light: { type: 'object', description: '신호등 판정 결과' },
            },
          },
        },
      },
      EvaluateRequest: {
        type: 'object',
        required: ['product', 'nutrition'],
        properties: {
          product: {
            type: 'object',
            required: ['serving_size'],
            properties: {
              product_name: { type: 'string' },
              food_type: { type: 'string' },
              content_unit: { type: 'string', enum: ['g', 'ml'] },
              serving_size: { type: 'number' },
              total_content: { type: 'number' },
            },
          },
          nutrition: {
            type: 'object',
            properties: {
              calories: { type: 'number' },
              sodium: { type: 'number' },
              sugars: { type: 'number' },
              sat_fat: { type: 'number' },
              total_fat: { type: 'number' },
              cholesterol: { type: 'number' },
              protein: { type: 'number' },
              fiber: { type: 'number' },
              trans_fat: { type: 'number' },
            },
          },
        },
      },
      OcrAnalyzeRequest: {
        type: 'object',
        required: ['image'],
        properties: {
          image: { type: 'string', description: 'base64 인코딩된 식품 라벨 이미지 (data:image/... 접두사 포함 가능)' },
          product_info: {
            type: 'object',
            description: '제품 보조 정보 (선택, OCR 추출 불가 시 사용)',
            properties: {
              product_name: { type: 'string' },
              food_type: { type: 'string' },
              content_unit: { type: 'string', enum: ['g', 'ml'] },
              serving_size: { type: 'number' },
              total_content: { type: 'number' },
            },
          },
        },
      },
    },
  },
};

module.exports = swaggerDocument;
