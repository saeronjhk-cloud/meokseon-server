// 식약처 식품영양성분DB API 전체 totalCount 확인 (부분/전수 다운로드 판별)
const https = require('https');
const KEY = '3ab67d3d7766c40a4f2a9e40cbdcc87befaa901d33126c63748ae2e3b6724c2b';
const url = `https://apis.data.go.kr/1471000/FoodNtrCpntDbInfo02/getFoodNtrCpntDbInq02?serviceKey=${KEY}&pageNo=1&numOfRows=1&type=json`;

https.get(url, { timeout: 30000 }, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    try {
      const j = JSON.parse(d);
      const tc = j.body?.totalCount ?? j.totalCount ?? j.response?.body?.totalCount ?? null;
      console.log('=== API 전체 totalCount:', tc, '===');
      console.log('(우리 staging_nutrition: 302,629건 — 이보다 크면 부분 다운로드)');
    } catch (e) {
      console.log('JSON 파싱 실패. 원문 일부:\n', d.slice(0, 600));
    }
  });
}).on('error', e => console.log('ERR', e.message))
  .on('timeout', function () { this.destroy(); console.log('타임아웃'); });
