/**
 * 먹선(吃選) 서버 엔트리포인트
 */

require('dotenv').config();
const app = require('./app');
const config = require('./config');
const logger = require('./config/logger');
const dictionaryCache = require('./services/dictionaryCache');
// SOURCE: IP/pulse/auth_routes_design_2026-05-20.md §2-3 + cursor_prompts/01_firebase_admin.md §3-3
const { initFirebase } = require('./config/firebase');

const PORT = config.port;

async function startServer() {
  // Firebase Admin SDK 초기화 (환경변수 누락 시 throw → fail-fast 의도).
  initFirebase();

  // 사전 데이터 캐시 로드
  await dictionaryCache.loadFromDB();

  app.listen(PORT, () => {
    logger.info('먹선(吃選) API 서버 가동', { env: config.env, port: PORT });
    console.log(`\n🍽️  먹선(吃選) API 서버 가동`);
    console.log(`   환경: ${config.env}`);
    console.log(`   포트: ${PORT}`);
    console.log(`   API:  http://localhost:${PORT}/api`);
    console.log(`   문서: http://localhost:${PORT}/api-docs`);
    console.log(`   헬스: http://localhost:${PORT}/api/health\n`);
  });
}

startServer().catch(err => {
  logger.error('서버 시작 실패', { error: err.message, stack: err.stack });
  console.error('서버 시작 실패:', err);
  process.exit(1);
});
