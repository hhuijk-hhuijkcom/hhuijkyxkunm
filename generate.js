const fs = require('fs');
const path = require('path');
const https = require('https');
let SteamUser;
try {
  SteamUser = require('steam-user');
} catch (e) {
  console.error('❌ 缺少 steam-user 模块');
  console.error('错误:', e.message);
  process.exit(1);
}
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const LUA_DIR = path.join(__dirname, 'lua');
const APPIDS_FILE = path.join(__dirname, 'appids.txt');
const PAID_NO_KEY_FILE = path.join(__dirname, 'paid_no_key_ids.txt');
const FAILED_FILE = path.join(__dirname, 'failed_ids.txt');
const DEPOT_KEYS_FILE = path.join(__dirname, 'depotkeys.json');
const ACCESS_TOKENS_FILE = path.join(__dirname, 'appaccesstokens.json');
const PROGRESS_FILE = path.join(__dirname, 'progress.txt');
const STATS_FILE = path.join(__dirname, 'stats.json');
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '50');
const FORCE_REGEN = process.env.FORCE_REGEN === 'true';
const MODE = process.env.MODE || 'all';
const SINGLE_APPID = process.env.SINGLE_APPID;
// 读取数据文件
const depotKeys = JSON.parse(fs.readFileSync(DEPOT_KEYS_FILE, 'utf-8'));
const accessTokens = fs.existsSync(ACCESS_TOKENS_FILE)
  ? JSON.parse(fs.readFileSync(ACCESS_TOKENS_FILE, 'utf-8'))
  : {};
if (!fs.existsSync(LUA_DIR)) fs.mkdirSync(LUA_DIR, { recursive: true });
// 根据模式选择 AppID 列表
let allAppIds = [];
let currentListFile = '';
if (SINGLE_APPID) {
  // 单个 AppID 模式（由程序内 GitHub 生成触发）
  currentListFile = 'single';
  allAppIds = [String(SINGLE_APPID).trim()];
} else if (MODE === 'paid_no_key') {
  currentListFile = PAID_NO_KEY_FILE;
  if (fs.existsSync(PAID_NO_KEY_FILE)) {
    allAppIds = fs.readFileSync(PAID_NO_KEY_FILE, 'utf-8')
      .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  }
} else if (MODE === 'failed') {
  currentListFile = FAILED_FILE;
  if (fs.existsSync(FAILED_FILE)) {
    allAppIds = fs.readFileSync(FAILED_FILE, 'utf-8')
      .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  }
} else {
  currentListFile = APPIDS_FILE;
  allAppIds = fs.readFileSync(APPIDS_FILE, 'utf-8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}
// 读取进度（单个 AppID 模式跳过进度恢复）
let startIndex = parseInt(process.env.START_FROM || '0');
const progressKey = `progress_${MODE}`;
if (!SINGLE_APPID && startIndex === 0 && fs.existsSync(path.join(__dirname, progressKey + '.txt'))) {
  const progress = parseInt(fs.readFileSync(path.join(__dirname, progressKey + '.txt'), 'utf-8').trim());
  if (!isNaN(progress) && progress > 0) {
    startIndex = progress;
    console.log(`📋 从进度文件恢复，从第 ${startIndex} 个开始`);
  }
}
// 读取已有的付费无密钥列表（避免重复添加）
let paidNoKeyIds = [];
if (fs.existsSync(PAID_NO_KEY_FILE)) {
  paidNoKeyIds = fs.readFileSync(PAID_NO_KEY_FILE, 'utf-8')
    .split('\n').map(l => l.trim()).filter(Boolean);
}
let failedIds = [];
if (fs.existsSync(FAILED_FILE)) {
  failedIds = fs.readFileSync(FAILED_FILE, 'utf-8')
    .split('\n').map(l => l.trim()).filter(Boolean);
}
let stats = {
  total: 0, success: 0, skipped: 0, failed: 0, noKey: 0, freeGame: 0,
  gotKeyNow: 0, stillNoKey: 0,
  mode: SINGLE_APPID ? 'single' : MODE,
  startTime: new Date().toISOString(),
};
// Steam 客户端
const steamClient = new SteamUser({ enablePicsCache: false, autoRelogin: false });
let steamReady = false;
let steamLogonPromise = null;
function loginSteam() {
  if (steamReady) return Promise.resolve();
  if (steamLogonPromise) return steamLogonPromise;
  steamLogonPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Steam 登录超时')), 30000);
    steamClient.once('loggedOn', () => {
      clearTimeout(timeout);
      steamReady = true;
      console.log('✅ Steam 匿名登录成功');
      resolve();
    });
    steamClient.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    steamClient.logOn({ anonymous: true });
  });
  return steamLogonPromise;
}
function getDepotIdsFromSteam(appId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('获取 depot 超时')), 20000);
    steamClient.getProductInfo([appId], [], false, (err, apps) => {
      clearTimeout(timeout);
      if (err) { reject(err); return; }
      const app = apps && apps[appId];
      const depots = app && app.appinfo && app.appinfo.depots;
      if (depots) {
        resolve(Object.keys(depots).filter(k => !isNaN(k)).map(Number).sort((a, b) => a - b));
      } else {
        resolve([]);
      }
    });
  });
}
function httpRequest(hostname, urlPath, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: urlPath, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': 'wants_mature_content=1; lastagecheckage=1-0-1990; birthtime=0;',
      },
      rejectUnauthorized: false,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const location = new URL(res.headers.location, `https://${hostname}`);
        httpRequest(location.hostname, location.pathname + location.search, timeout)
          .then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}
async function getAppInfo(appId) {
  try {
    const data = await httpRequest(
      'store.steampowered.com',
      `/api/appdetails?appids=${appId}&l=schinese&cc=hk`,
      10000
    );
    const json = JSON.parse(data);
    if (json[appId] && json[appId].success && json[appId].data) {
      return json[appId].data;
    }
  } catch (e) {
    console.log(`  ⚠️ API请求失败: ${e.message}`);
  }
  return null;
}
function generateLuaContent(appId, depotIds, dlcList, dlcDepotMap) {
  const appIdNum = parseInt(appId);
  const depotsWithKey = depotIds.filter(did => depotKeys[did]);
  let lua = `--H-huijk\n`;
  lua += `--主游戏APPID: ${appId}\n`;
  if (depotKeys[appIdNum]) {
    lua += `addappid(${appIdNum},0,"${depotKeys[appIdNum]}") -- 主游戏\n`;
  } else {
    lua += `addappid(${appIdNum}) -- 主游戏\n`;
  }
  lua += '\n--depotsID\n';
  depotsWithKey.forEach(depotId => {
    lua += `addappid(${depotId},0,"${depotKeys[depotId]}")\n`;
  });
  const dlcWithAllKeys = [];
  const dlcWithoutAllKeys = [];
  for (const [dlcId, dlcDepots] of Object.entries(dlcDepotMap)) {
    const dlcDepotNum = dlcDepots.map(Number);
    if (dlcDepotNum.length > 0 && dlcDepotNum.every(d => depotKeys[d])) {
      dlcWithAllKeys.push({ id: Number(dlcId), depots: dlcDepotNum });
    } else {
      dlcWithoutAllKeys.push({ id: Number(dlcId), depots: dlcDepotNum });
    }
  }
  if (dlcWithAllKeys.length > 0) {
    lua += '\n--有多个子仓库的DLC ID都有密钥\n';
    dlcWithAllKeys.forEach(dlc => {
      const count = dlc.depots.length;
      let comment = '';
      if (count > 1) {
        comment = ` -- 有${count}个子仓库且都有密钥`;
      } else if (dlc.depots[0] !== dlc.id) {
        comment = ' -- 唯一子仓库与DLC ID不同且有密钥';
      }
      lua += `addappid(${dlc.id})${comment}\n`;
    });
  }
  // 收集所有无密钥的 depots（主游戏 + DLC 的无密钥 depots）
  const depotsWithoutKey = depotIds.filter(did => !depotKeys[did]);
  dlcWithoutAllKeys.forEach(dlc => {
    dlc.depots.forEach(did => {
      if (!depotKeys[did] && !depotsWithoutKey.includes(did)) {
        depotsWithoutKey.push(did);
      }
    });
  });
  if (depotsWithoutKey.length > 0 || dlcWithoutAllKeys.length > 0) {
    lua += '\n--无仓库DLC\n';
    depotsWithoutKey.forEach(depotId => {
      lua += `addappid(${depotId})\n`;
    });
    // 输出检测到但没有完整密钥的 DLC appid
    dlcWithoutAllKeys.forEach(dlc => {
      if (!depotsWithoutKey.includes(dlc.id)) {
        lua += `addappid(${dlc.id}) -- DLC\n`;
      }
    });
  }
  const tokenIds = [];
  for (const dlcId of dlcList) {
    if (accessTokens[dlcId]) tokenIds.push(dlcId);
  }
  if (accessTokens[appIdNum]) tokenIds.push(appIdNum);
  if (tokenIds.length > 0) {
    lua += '\n--Token\n';
    tokenIds.forEach(id => {
      lua += `addtoken(${id},"${accessTokens[id]}")\n`;
    });
  }
  return lua;
}
async function sendNotification(stats) {
  const webhook = process.env.WECOM_WEBHOOK;
  if (!webhook) return;
  const modeLabel = SINGLE_APPID
    ? `单个生成 (${SINGLE_APPID})`
    : ({ all: '全量处理', paid_no_key: '付费无密钥', failed: '失败重试' }[MODE] || MODE);
  const content = [
    '## 🤖 Lua批量生成完成',
    `> 仓库: hhuijkyxkunm`,
    `> 模式: ${modeLabel}`,
    `> 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    '',
    '### 统计',
    `> 总计: ${stats.total}`,
    `> ✅ 成功: ${stats.success}`,
    `> ⏭️ 跳过: ${stats.skipped}`,
    `> ❌ 失败: ${stats.failed}`,
    `> 🔑 无密钥: ${stats.noKey}`,
    `> 🆓 免费游戏: ${stats.freeGame}`,
  ];
  if (!SINGLE_APPID && MODE === 'paid_no_key') {
    content.push(`> 🔓 已获得密钥并生成: ${stats.gotKeyNow}`);
    content.push(`> ⏳ 仍无密钥: ${stats.stillNoKey}`);
  }
  content.push('', `> [查看详情](https://github.com/hhuijk-hhuijkcom/hhuijkyxkunm/actions)`);
  try {
    const data = JSON.stringify({ msgtype: 'markdown', markdown: { content: content.join('\n') } });
    const url = new URL(webhook);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>console.log('通知已发送')); });
    req.on('error', (e) => console.log('通知发送失败:', e.message));
    req.write(data); req.end();
  } catch (e) { console.log('通知发送失败:', e.message); }
}
async function processAppId(appId) {
  const luaPath = path.join(LUA_DIR, `${appId}.lua`);
  const appIdNum = parseInt(appId);
  stats.total++;
  // 单个模式：如果已存在且未强制重新生成，跳过
  if (SINGLE_APPID && fs.existsSync(luaPath) && !FORCE_REGEN) {
    console.log(`  ⏭️ 已存在 lua 文件，跳过（如需重新生成请设置 FORCE_REGEN=true）`);
    stats.skipped++;
    return;
  }
  // Steam Store API 获取 DLC 和价格
  const appData = await getAppInfo(appId);
  const dlcList = (appData && appData.dlc && Array.isArray(appData.dlc)) ? appData.dlc : [];
  // steam-user 获取 depots
  let depotIds = [];
  try {
    depotIds = await getDepotIdsFromSteam(appIdNum);
  } catch (e) {
    console.log(`  ⚠️ 获取 depot 失败: ${e.message}`);
  }
  // 获取每个 DLC 的 depots
  const dlcDepotMap = {};
  for (const dlcId of dlcList) {
    try {
      dlcDepotMap[dlcId] = await getDepotIdsFromSteam(dlcId);
    } catch (e) {
      dlcDepotMap[dlcId] = [];
    }
    await new Promise(r => setTimeout(r, 300));
  }
  // 密钥检查
  const hasMainKey = !!depotKeys[appIdNum];
  const depotsWithKey = depotIds.filter(did => depotKeys[did]);
  const hasAnyKey = hasMainKey || depotsWithKey.length > 0;
  const free = appData ? (!appData.price_overview || appData.price_overview.final === 0) : false;
  if (SINGLE_APPID) {
    // 单个模式：付费无密钥也记录到列表，但不跳过生成（免费游戏或无密钥都生成）
    if (!hasAnyKey && !free) {
      console.log(`  🔑 付费游戏无密钥，记录到付费无密钥列表`);
      stats.noKey++;
      if (!paidNoKeyIds.includes(appId)) {
        paidNoKeyIds.push(appId);
      }
      // 仍然生成 lua（无密钥部分）
      const luaContent = generateLuaContent(appId, depotIds, dlcList, dlcDepotMap);
      fs.writeFileSync(luaPath, luaContent);
      console.log(`  ✅ 生成完成 (${depotIds.length} depots, ${dlcList.length} DLC) - 无主密钥`);
      stats.success++;
      return;
    }
    if (!hasAnyKey && free) {
      console.log(`  🆓 免费游戏无密钥，继续生成`);
      stats.freeGame++;
    }
    // 生成 lua
    const luaContent = generateLuaContent(appId, depotIds, dlcList, dlcDepotMap);
    fs.writeFileSync(luaPath, luaContent);
    console.log(`  ✅ 生成完成 (${depotIds.length} depots, ${dlcList.length} DLC)`);
    stats.success++;
    // 如果有密钥了，从付费无密钥列表移除
    if (hasAnyKey) {
      paidNoKeyIds = paidNoKeyIds.filter(id => id !== appId);
    }
    return;
  }
  if (MODE === 'paid_no_key') {
    // 付费无密钥模式：只检查是否现在有密钥
    if (hasAnyKey) {
      // 有密钥了！生成 lua 并从列表中删除
      console.log(`  🔓 已获得密钥！开始生成`);
      const luaContent = generateLuaContent(appId, depotIds, dlcList, dlcDepotMap);
      fs.writeFileSync(luaPath, luaContent);
      console.log(`  ✅ 生成完成，从付费无密钥列表中移除`);
      stats.success++;
      stats.gotKeyNow++;
      // 从 paidNoKeyIds 中移除
      paidNoKeyIds = paidNoKeyIds.filter(id => id !== appId);
    } else {
      // 仍然没有密钥，保留在列表中
      if (!free) {
        console.log(`  ⏳ 仍然无密钥，保留在列表中`);
        stats.stillNoKey++;
      } else {
        // 免费游戏不需要密钥，直接生成并移除
        console.log(`  🆓 免费游戏，生成 lua`);
        const luaContent = generateLuaContent(appId, depotIds, dlcList, dlcDepotMap);
        fs.writeFileSync(luaPath, luaContent);
        stats.success++;
        stats.freeGame++;
        paidNoKeyIds = paidNoKeyIds.filter(id => id !== appId);
      }
    }
    return;
  }
  // 正常模式 / 失败重试模式
  if (!hasAnyKey && !free) {
    // 付费游戏无密钥
    console.log(`  🔑 付费游戏无密钥，跳过`);
    stats.noKey++;
    // 添加到付费无密钥列表（避免重复）
    if (!paidNoKeyIds.includes(appId)) {
      paidNoKeyIds.push(appId);
    }
    return;
  }
  if (!hasAnyKey && free) {
    console.log(`  🆓 免费游戏无密钥，继续生成`);
    stats.freeGame++;
  }
  // 生成 lua
  const luaContent = generateLuaContent(appId, depotIds, dlcList, dlcDepotMap);
  fs.writeFileSync(luaPath, luaContent);
  console.log(`  ✅ 生成完成 (${depotIds.length} depots, ${dlcList.length} DLC)`);
  stats.success++;
  // 成功后从失败列表中移除
  failedIds = failedIds.filter(id => id !== appId);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function main() {
  console.log('========================================');
  console.log('🤖 hhuijk Lua 批量生成脚本');
  if (SINGLE_APPID) {
    console.log(`🎯 单个生成模式: AppID ${SINGLE_APPID}`);
  } else {
    console.log(`📋 模式: ${MODE}`);
    console.log(`📋 总AppID数: ${allAppIds.length}`);
    console.log(`📌 起始位置: ${startIndex}`);
    console.log(`📦 批次大小: ${BATCH_SIZE}`);
    console.log(`🔄 强制重新生成: ${FORCE_REGEN}`);
  }
  console.log('========================================\n');
  if (allAppIds.length === 0) {
    console.log('⚠️ 没有需要处理的 AppID');
    await sendNotification(stats);
    process.exit(0);
  }
  console.log('🔐 正在登录 Steam...');
  try {
    await loginSteam();
  } catch (e) {
    console.error('❌ Steam 登录失败:', e.message);
    console.log('⚠️ 将仅使用 Steam Store API');
  }
  const batch = SINGLE_APPID ? allAppIds : allAppIds.slice(startIndex, startIndex + BATCH_SIZE);
  for (let i = 0; i < batch.length; i++) {
    const appId = batch[i];
    const globalIndex = SINGLE_APPID ? 0 : (startIndex + i);
    console.log(`[${globalIndex + 1}/${allAppIds.length}] AppID: ${appId}`);
    try {
      await processAppId(appId);
    } catch (e) {
      console.log(`  ❌ ${e.message}`);
      stats.failed++;
      // 正常模式下才记录失败，失败重试模式下不重复添加
      if (!SINGLE_APPID && MODE !== 'failed' && !failedIds.includes(appId)) {
        failedIds.push(appId);
      }
    }
    // 保存进度（单个模式跳过）
    if (!SINGLE_APPID) {
      fs.writeFileSync(path.join(__dirname, progressKey + '.txt'), String(globalIndex + 1));
    }
    // 保存付费无密钥列表
    fs.writeFileSync(PAID_NO_KEY_FILE, paidNoKeyIds.join('\n') + (paidNoKeyIds.length > 0 ? '\n' : ''));
    // 保存失败列表（单个模式跳过）
    if (!SINGLE_APPID) {
      fs.writeFileSync(FAILED_FILE, failedIds.join('\n') + (failedIds.length > 0 ? '\n' : ''));
    }
    await sleep(500);
  }
  stats.endTime = new Date().toISOString();
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  console.log('\n========================================');
  console.log('📊 统计:');
  console.log(`  总计: ${stats.total}`);
  console.log(`  成功: ${stats.success}`);
  console.log(`  跳过: ${stats.skipped}`);
  console.log(`  失败: ${stats.failed}`);
  console.log(`  无密钥: ${stats.noKey}`);
  console.log(`  免费游戏: ${stats.freeGame}`);
  if (!SINGLE_APPID && MODE === 'paid_no_key') {
    console.log(`  已获得密钥并生成: ${stats.gotKeyNow}`);
    console.log(`  仍无密钥: ${stats.stillNoKey}`);
  }
  console.log('========================================');
  if (!SINGLE_APPID) {
    console.log(`📝 付费无密钥列表: ${paidNoKeyIds.length} 个`);
    console.log(`📝 失败列表: ${failedIds.length} 个`);
  }
  await sendNotification(stats);
  if (!SINGLE_APPID && startIndex + BATCH_SIZE < allAppIds.length) {
    console.log(`\n⏭️ 还有 ${allAppIds.length - startIndex - BATCH_SIZE} 个待处理`);
  } else {
    console.log('\n🎉 本批次处理完成！');
    if (!SINGLE_APPID) {
      fs.writeFileSync(path.join(__dirname, progressKey + '.txt'), '0');
    }
  }
  try { steamClient.logOff(); } catch (_) {}
  process.exit(0);
}
main().catch(e => {
  console.error('脚本执行失败:', e);
  try { steamClient.logOff(); } catch (_) {}
  process.exit(1);
});
