const fs = require('fs');
const path = require('path');
const SteamUser = require('steam-user');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const INPUT = process.env.INPUT_APP_IDS || '';
const APP_IDS = INPUT.split(',').map(s => s.trim()).filter(s => s && /^\d+$/.test(s));

function parseLuaIds(content) {
  const ids = new Set();
  let m;
  const reApp = /addappid\s*\(\s*(\d+)/g;
  while ((m = reApp.exec(content)) !== null) ids.add(Number(m[1]));
  const reToken = /addtoken\s*\(\s*(\d+)/g;
  while ((m = reToken.exec(content)) !== null) ids.add(Number(m[1]));
  return ids;
}

function loginSteam() {
  return new Promise((resolve) => {
    const c = new SteamUser({ enablePicsCache: false, autoRelogin: false });
    let done = false;
    const finish = (ok, reason) => {
      if (done) return; done = true; clearTimeout(t);
      if (ok) resolve({ ok: true, client: c });
      else { try { c.logOff(); } catch (_) {} resolve({ ok: false, reason }); }
    };
    const t = setTimeout(() => finish(false, 'timeout'), 25000);
    c.once('loggedOn', () => finish(true));
    c.once('error', (e) => finish(false, String(e.message || e)));
    c.once('debug', () => {});
    try { c.logOn({ anonymous: true }); } catch (e) { finish(false, String(e.message)); }
  });
}

function getDepotIds(client, appId) {
  return new Promise((resolve) => {
    try {
      client.getProductInfo([appId], [], false, (err, apps) => {
        if (err || !apps || !apps[appId] || !apps[appId].appinfo || !apps[appId].appinfo.depots) {
          resolve([]); return;
        }
        resolve(Object.keys(apps[appId].appinfo.depots).filter(k => !isNaN(k)).map(Number));
      });
    } catch (_) { resolve([]); }
  });
}

async function getDepotIdsTwice(client, appId) {
  if (!client) return [];
  const a = await getDepotIds(client, appId);
  await new Promise(r => setTimeout(r, 800));
  const b = await getDepotIds(client, appId);
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

async function main() {
  const lines = [];
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  lines.push('========================================');
  lines.push(`  Lua 完整性检查报告`);
  lines.push(`  生成时间: ${now}`);
  lines.push(`  （记得去反馈）检测文件数: ${APP_IDS.length}`);
  lines.push('========================================');
  lines.push('');

  console.log('Steam login...');
  const loginRes = await loginSteam();
  if (!loginRes.ok) {
    lines.push(`❌ Steam 登录失败: ${loginRes.reason}`);
    fs.writeFileSync('check-report.txt', lines.join('\n'));
    process.exit(1);
  }
  const client = loginRes.client;
  console.log('OK\n');

  let okCount = 0, fileMissingCount = 0, missingCount = 0, errCount = 0;
  const fileMissingList = [];
  const missingList = [];

  for (let idx = 0; idx < APP_IDS.length; idx++) {
    const appId = APP_IDS[idx];
    const luaPath = path.join('lua', `${appId}.lua`);
    const tag = `[${idx + 1}/${APP_IDS.length}]`;

    try {
      const luaExists = fs.existsSync(luaPath);
      let remoteIds = new Set();
      if (luaExists) remoteIds = parseLuaIds(fs.readFileSync(luaPath, 'utf-8'));

      const depots = await getDepotIdsTwice(client, Number(appId));
      const realIds = new Set([Number(appId), ...depots]);
      const missing = [...realIds].filter(id => !remoteIds.has(id)).sort((a, b) => a - b);

      if (!luaExists) {
        fileMissingCount++;
        fileMissingList.push(appId);
        lines.push(`🗂️ ${appId}.lua — 缺少文件 (steam depot=${depots.length})`);
        console.log(`${tag} 🗂️ ${appId}.lua missing`);
      } else if (missing.length > 0) {
        missingCount++;
        missingList.push({ appId, count: missing.length, ids: missing.join(',') });
        lines.push(`⚠️ ${appId}.lua — 缺 ${missing.length} 个 depot (steam=${depots.length}, 本地=${remoteIds.size})`);
        console.log(`${tag} ⚠️ ${appId}.lua missing ${missing.length}`);
      } else {
        okCount++;
        console.log(`${tag} ✅ ${appId}.lua`);
      }
      await new Promise(r => setTimeout(r, 1200));
    } catch (e) {
      errCount++;
      lines.push(`❌ ${appId}.lua — 检测失败: ${e.message}`);
      console.log(`${tag} ❌ ${appId}: ${e.message}`);
      await new Promise(r => setTimeout(r, 800));
    }
  }

  lines.push('');
  lines.push('========================================');
  lines.push(`  ✅ 正常: ${okCount}`);
  lines.push(`  🗂️ 缺少文件: ${fileMissingCount}`);
  lines.push(`  ⚠️ 缺depot: ${missingCount}`);
  lines.push(`  ❌ 错误: ${errCount}`);
  lines.push(`  📊 总计: ${APP_IDS.length}`);
  lines.push('========================================');

  fs.writeFileSync('check-report.txt', lines.join('\n'), 'utf-8');
  try { client.logOff(); } catch (_) {}
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
