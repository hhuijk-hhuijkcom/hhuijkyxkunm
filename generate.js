// generate.js
const fs = require('fs');
const path = require('path');
const https = require('https');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const LUA_DIR = path.join(__dirname, 'lua');
const APPIDS_FILE = path.join(__dirname, 'appids.txt');
const DEPOT_KEYS_FILE = path.join(__dirname, 'depotkeys.json');
const ACCESS_TOKENS_FILE = path.join(__dirname, 'appaccesstokens.json');
const PROGRESS_FILE = path.join(__dirname, 'progress.txt');
const FAILED_FILE = path.join(__dirname, 'failed_ids.txt');
const STATS_FILE = path.join(__dirname, 'stats.json');

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '50');
const FORCE_REGEN = process.env.FORCE_REGEN === 'true';

// 读取数据文件
const appidsText = fs.readFileSync(APPIDS_FILE, 'utf-8');
const allAppIds = appidsText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

const depotKeys = JSON.parse(fs.readFileSync(DEPOT_KEYS_FILE, 'utf-8'));
const accessTokens = fs.existsSync(ACCESS_TOKENS_FILE)
  ? JSON.parse(fs.readFileSync(ACCESS_TOKENS_FILE, 'utf-8'))
  : {};

// 确保lua目录存在
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

// 读取失败记录
let failedIds = [];
if (fs.existsSync(FAILED_FILE)) {
  failedIds = fs.readFileSync(FAILED_FILE, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
}

// 统计
let stats = {
  total: 0,
  success: 0,
  skipped: 0,
  failed: 0,
  noKey: 0,
  freeGame: 0,
  startTime: new Date().toISOString(),
};

// HTTP 请求函数
function httpRequest(hostname, urlPath, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path: urlPath,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': 'wants_mature_content=1; lastagecheckage=1-0-1990; birthtime=0;',
      },
      rejectUnauthorized: false,
    }, (res) => {
      // 跟随重定向
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const location = new URL(res.headers.location, `https://${hostname}`);
        httpRequest(location.hostname, location.pathname + location.search, timeout)
          .then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

// 从 Steam API 获取应用详情
async function getAppDetails(appId) {
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

// 获取 depot IDs
async function getDepotIds(appId, appData) {
  if (appData && appData.depots) {
    return Object.keys(appData.depots).filter(k => !isNaN(k)).map(Number).sort((a, b) => a - b);
  }
  return [];
}

// 获取 DLC 列表
function getDlcList(appData) {
  if (appData && appData.dlc && Array.isArray(appData.dlc)) {
    return appData.dlc;
  }
  return [];
}

// 检查是否免费
function isFree(appData) {
  if (!appData) return false;
  const price = appData.price_overview;
  return !price || price.final === 0;
}

// 获取 DLC 的 depot IDs
async function getDlcDepotIds(dlcId) {
  try {
    const data = await getAppDetails(dlcId);
    if (data && data.depots) {
      return Object.keys(data.depots).filter(k => !isNaN(k)).map(Number).sort((a, b) => a - b);
    }
  } catch (e) {}
  return [];
}

// 生成 Lua 内容（与程序格式完全一致）
function generateLuaContent(appId, depotIds, dlcList, dlcDepotMap) {
  const appIdNum = parseInt(appId);
  const depotsWithKey = depotIds.filter(did => depotKeys[did]);
  const hasMainKey = !!depotKeys[appIdNum];

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
    const data = JSON.stringify({
      msgtype: 'markdown',
      markdown: { content },
    });
    const url = new URL(webhook);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => console.log('通知已发送'));
    });
    req.on('error', (e) => console.log('通知发送失败:', e.message));
    req.write(data);
    req.end();
  } catch (e) {
    console.log('通知发送失败:', e.message);
  }
}

// 主处理函数
async function processAppId(appId) {
  const luaPath = path.join(LUA_DIR, `${appId}.lua`);

  // 跳过已存在（非强制重新生成）
  if (!FORCE_REGEN && fs.existsSync(luaPath)) {
    stats.skipped++;
    return;
  }

  const appIdNum = parseInt(appId);
  stats.total++;

  // 获取应用详情
  const appData = await getAppDetails(appId);
  if (!appData) {
    console.log(`❌ ${appId}: API无数据`);
    stats.failed++;
    failedIds.push(appId);
    return;
  }

  // 获取 depot IDs
  const depotIds = await getDepotIds(appId, appData);
  const dlcList = getDlcList(appData);

  // 获取每个DLC的depot IDs
  const dlcDepotMap = {};
  for (const dlcId of dlcList) {
    dlcDepotMap[dlcId] = await getDlcDepotIds(dlcId);
    await new Promise(r => setTimeout(r, 200)); // 避免请求过快
  }

  // 检查密钥
  const hasMainKey = !!depotKeys[appIdNum];
  const depotsWithKey = depotIds.filter(did => depotKeys[did]);

  if (!hasMainKey && depotsWithKey.length === 0) {
    const free = isFree(appData);
    if (!free) {
      console.log(`🔑 ${appId}: 付费游戏无密钥，跳过`);
      stats.noKey++;
      return;
    }
    console.log(`🆓 ${appId}: 免费游戏无密钥，继续生成`);
    stats.freeGame++;
  }

  // 生成lua文件
  const luaContent = generateLuaContent(appId, depotIds, dlcList, dlcDepotMap);
  fs.writeFileSync(luaPath, luaContent);
  console.log(`✅ ${appId}: 生成完成 (${depotIds.length} depots, ${dlcList.length} DLC)`);
  stats.success++;
}

// 延迟函数
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 主函数
async function main() {
  console.log('========================================');
  console.log('🤖 hhuijk Lua 批量生成脚本');
  console.log(`📋 总AppID数: ${allAppIds.length}`);
  console.log(`📌 起始位置: ${startIndex}`);
  console.log(`📦 批次大小: ${BATCH_SIZE}`);
  console.log(`🔄 强制重新生成: ${FORCE_REGEN}`);
  console.log('========================================\n');

  const batch = allAppIds.slice(startIndex, startIndex + BATCH_SIZE);
  const actualStart = startIndex;

  for (let i = 0; i < batch.length; i++) {
    const appId = batch[i];
    const globalIndex = actualStart + i;
    console.log(`[${globalIndex + 1}/${allAppIds.length}] 处理 AppID: ${appId}`);

    try {
      await processAppId(appId);
    } catch (e) {
      console.log(`❌ ${appId}: ${e.message}`);
      stats.failed++;
      failedIds.push(appId);
    }

    // 保存进度
    fs.writeFileSync(PROGRESS_FILE, String(globalIndex + 1));

    // 保存失败记录
    fs.writeFileSync(FAILED_FILE, failedIds.join('\n'));

    // 请求间隔
    await sleep(500);
  }

  // 保存统计
  stats.endTime = new Date().toISOString();
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));

  console.log('\n========================================');
  console.log('📊 统计结果:');
  console.log(`  总计: ${stats.total}`);
  console.log(`  成功: ${stats.success}`);
  console.log(`  跳过: ${stats.skipped}`);
  console.log(`  失败: ${stats.failed}`);
  console.log(`  无密钥: ${stats.noKey}`);
  console.log(`  免费游戏: ${stats.freeGame}`);
  console.log('========================================\n');

  // 发送通知
  await sendNotification(stats);

  // 如果还有剩余，提示继续
  if (startIndex + BATCH_SIZE < allAppIds.length) {
    console.log(`\n⏭️ 还有 ${allAppIds.length - startIndex - BATCH_SIZE} 个待处理`);
    console.log(`进度已保存，下次运行将自动从 ${startIndex + BATCH_SIZE} 继续`);
  } else {
    console.log('\n🎉 全部处理完成！');
    // 重置进度
    fs.writeFileSync(PROGRESS_FILE, '0');
  }
}

main().catch(e => {
  console.error('脚本执行失败:', e);
  process.exit(1);
});
