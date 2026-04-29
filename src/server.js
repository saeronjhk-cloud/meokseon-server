/**
 * 먹선(吃選) 서버 엔트리포인트
 */

require('dotenv').config();
const app = require('./app');
const config = require('./config');
const logger = require('./config/logger');
const dictionaryCache = require('./services/dictionaryCache');

const PORT = config.port;

async function startServer() {
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
