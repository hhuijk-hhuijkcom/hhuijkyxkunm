// generate.js
const fs = require('fs');
const path = require('path');
const https = require('https');
const SteamUser = require('steam-user');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const LUA_DIR = path.join(__dirname, 'lua');
const APPIDS_FILE = path.join(__dirname, 'appids.txt');
const DEPOT_KEYS_FILE = path.join(__dirname, 'depotkeys.json');
const ACCESS_TOKENS_FILE = path.join(__dirname, 'appaccesstokens.json');
const PROGRESS_FILE = path.join(__dirname, 'progress.txt');
const FAILED_FILE = path.join(__dirname, 'failed_ids.txt');
const STATS_FILE = path.join(__dirname, 'stats.json');

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '50');
const FORCE_REGEN = process.env.FORCE_REGEN === 'false' ? false : true;

// 读取数据文件
const appidsText = fs.readFileSync(APPIDS_FILE, 'utf-8');
const allAppIds = appidsText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

const depotKeys = JSON.parse(fs.readFileSync(DEPOT_KEYS_FILE, 'utf-8'));
const accessTokens = fs.existsSync(ACCESS_TOKENS_FILE)
  ? JSON.parse(fs.readFileSync(ACCESS_TOKENS_FILE, 'utf-8'))
  : {};

if (!fs.existsSync(LUA_DIR)) fs.mkdirSync(LUA_DIR, { recursive: true });

// 读取进度
let startIndex = parseInt(process.env.START_FROM || '0');
if (startIndex === 0 && fs.existsSync(PROGRESS_FILE)) {
  const progress = parseInt(fs.readFileSync(PROGRESS_FILE, 'utf-8').trim());
  if (!isNaN(progress) && progress > 0) {
    startIndex = progress;
    console.log(`📋 从进度文件恢复，从第 ${startIndex} 个开始`);
  }
}

let failedIds = [];
if (fs.existsSync(FAILED_FILE)) {
  failedIds = fs.readFileSync(FAILED_FILE, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
}

let stats = {
  total: 0, success: 0, skipped: 0, failed: 0, noKey: 0, freeGame: 0,
  startTime: new Date().toISOString(),
};

// Steam 客户端（匿名登录）
const steamClient = new SteamUser({ enablePicsCache: false, autoRelogin: false });
let steamReady = false;
let steamLogonPromise = null;

function loginSteam() {
  if (steamReady) return Promise.resolve();
  if (steamLogonPromise) return steamLogonPromise;

  steamLogonPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Steam 登录超时'));
    }, 20000);

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

// 通过 steam-user 获取 depot IDs
function getDepotIdsFromSteam(appId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('获取 depot 超时'));
    }, 15000);

    steamClient.getProductInfo([appId], [], false, (err, apps) => {
      clearTimeout(timeout);
      if (err) {
        reject(err);
        return;
      }
      const depots = apps && apps[appId] && apps[appId].appinfo && apps[appId].appinfo.depots;
      if (depots) {
        const depotIds = Object.keys(depots).filter(k => !isNaN(k)).map(Number).sort((a, b) => a - b);
        resolve(depotIds);
      } else {
        resolve([]);
      }
    });
  });
}

// 获取 DLC 的 depot IDs
async function getDlcDepotIds(dlcId) {
  try {
    return await getDepotIdsFromSteam(dlcId);
  } catch (e) {
    return [];
  }
}

// HTTP 请求
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

// 从 Steam Store API 获取 DLC 列表和是否免费
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
    console.log(`  API请求失败: ${e.message}`);
  }
  return null;
}

// 生成 Lua 内容（与程序格式完全一致）
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

  // depotsID
  lua += '\n--depotsID\n';
  depotsWithKey.forEach(depotId => {
    lua += `addappid(${depotId},0,"${depotKeys[depotId]}")\n`;
  });

  // 有多个子仓库的DLC ID都有密钥
  const dlcWithAllKeys = [];
  for (const [dlcId, dlcDepots] of Object.entries(dlcDepotMap)) {
    const dlcDepotNum = dlcDepots.map(Number);
    if (dlcDepotNum.length > 0 && dlcDepotNum.every(d => depotKeys[d])) {
      dlcWithAllKeys.push({ id: Number(dlcId), depots: dlcDepotNum });
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

  // 无仓库DLC
  const depotsWithoutKey = depotIds.filter(did => !depotKeys[did]);
  if (depotsWithoutKey.length > 0) {
    lua += '\n--无仓库DLC\n';
    depotsWithoutKey.forEach(depotId => {
      lua += `addappid(${depotId})\n`;
    });
  }

  // Token
  const tokenIds = [];
  for (const dlcId of dlcList) {
    if (accessTokens[dlcId]) {
      tokenIds.push(dlcId);
    }
  }
  if (accessTokens[appIdNum]) {
    tokenIds.push(appIdNum);
  }

  if (tokenIds.length > 0) {
    lua += '\n--Token\n';
    tokenIds.forEach(id => {
      lua += `addtoken(${id},"${accessTokens[id]}")\n`;
    });
  }

  return lua;
}

// 发送企微通知
async function sendNotification(stats) {
  const webhook = process.env.WECOM_WEBHOOK;
  if (!webhook) return;

  const content = [
    '## 🤖 Lua批量生成完成',
    `> 仓库: hhuijkyxkunm`,
    `> 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    '',
    '### 统计',
    `> 总计: ${stats.total}`,
    `> ✅ 成功: ${stats.success}`,
    `> ⏭️ 跳过: ${stats.skipped}`,
    `> ❌ 失败: ${stats.failed}`,
    `> 🔑 无密钥: ${stats.noKey}`,
    `> 🆓 免费游戏: ${stats.freeGame}`,
    '',
    `> [查看详情](https://github.com/hhuijk-hhuijkcom/hhuijkyxkunm/actions)`,
  ].join('\n');

  try {
    const data = JSON.stringify({ msgtype: 'markdown', markdown: { content } });
    const url = new URL(webhook);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>console.log('通知已发送')); });
    req.on('error', (e) => console.log('通知发送失败:', e.message));
    req.write(data); req.end();
  } catch (e) { console.log('通知发送失败:', e.message); }
}

// 处理单个 AppID
async function processAppId(appId) {
  const luaPath = path.join(LUA_DIR, `${appId}.lua`);

  if (!FORCE_REGEN && fs.existsSync(luaPath)) {
    stats.skipped++;
    return;
  }

  const appIdNum = parseInt(appId);
  stats.total++;

  // 1. 通过 Steam Store API 获取 DLC 列表和是否免费
  const appData = await getAppInfo(appId);
  const dlcList = (appData && appData.dlc && Array.isArray(appData.dlc)) ? appData.dlc : [];

  // 2. 通过 steam-user 获取主游戏 depot IDs
  let depotIds = [];
  try {
    depotIds = await getDepotIdsFromSteam(appIdNum);
    console.log(`  depots: ${depotIds.join(', ') || '无'}`);
  } catch (e) {
    console.log(`  ⚠️ 获取 depot 失败: ${e.message}`);
  }

  // 3. 获取每个 DLC 的 depot IDs
  const dlcDepotMap = {};
  for (const dlcId of dlcList) {
    dlcDepotMap[dlcId] = await getDlcDepotIds(dlcId);
    await new Promise(r => setTimeout(r, 300));
  }

  // 4. 检查密钥
  const hasMainKey = !!depotKeys[appIdNum];
  const depotsWithKey = depotIds.filter(did => depotKeys[did]);

  if (!hasMainKey && depotsWithKey.length === 0) {
    const free = appData ? (!appData.price_overview || appData.price_overview.final === 0) : false;
    if (!free) {
      console.log(`  🔑 付费游戏无密钥，跳过`);
      stats.noKey++;
      return;
    }
    console.log(`  🆓 免费游戏无密钥，继续生成`);
    stats.freeGame++;
  }

  // 5. 生成 lua 文件
  const luaContent = generateLuaContent(appId, depotIds, dlcList, dlcDepotMap);
  fs.writeFileSync(luaPath, luaContent);
  console.log(`  ✅ 生成完成 (${depotIds.length} depots, ${dlcList.length} DLC)`);
  stats.success++;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('========================================');
  console.log('🤖 hhuijk Lua 批量生成脚本');
  console.log(`📋 总AppID数: ${allAppIds.length}`);
  console.log(`📌 起始位置: ${startIndex}`);
  console.log(`📦 批次大小: ${BATCH_SIZE}`);
  console.log(`🔄 强制重新生成: ${FORCE_REGEN}`);
  console.log('========================================\n');

  // 登录 Steam
  console.log('🔐 正在登录 Steam...');
  try {
    await loginSteam();
  } catch (e) {
    console.error('❌ Steam 登录失败:', e.message);
    console.log('⚠️ 将仅使用 Steam Store API（depots 可能为空）');
  }

  const batch = allAppIds.slice(startIndex, startIndex + BATCH_SIZE);

  for (let i = 0; i < batch.length; i++) {
    const appId = batch[i];
    const globalIndex = startIndex + i;
    console.log(`[${globalIndex + 1}/${allAppIds.length}] AppID: ${appId}`);

    try {
      await processAppId(appId);
    } catch (e) {
      console.log(`  ❌ ${e.message}`);
      stats.failed++;
      failedIds.push(appId);
    }

    fs.writeFileSync(PROGRESS_FILE, String(globalIndex + 1));
    fs.writeFileSync(FAILED_FILE, failedIds.join('\n'));
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
  console.log('========================================\n');

  await sendNotification(stats);

  if (startIndex + BATCH_SIZE < allAppIds.length) {
    console.log(`⏭️ 还有 ${allAppIds.length - startIndex - BATCH_SIZE} 个待处理`);
  } else {
    console.log('🎉 全部处理完成！');
    fs.writeFileSync(PROGRESS_FILE, '0');
  }

  steamClient.logOff();
  process.exit(0);
}

main().catch(e => {
  console.error('脚本执行失败:', e);
  try { steamClient.logOff(); } catch(_) {}
  process.exit(1);
});
