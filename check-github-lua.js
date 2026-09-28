const fs = require('fs');
const path = require('path');
const https = require('https');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ===== config =====
const REPO_OWNER = 'hhuijk-hhuijkcom';
const REPO_NAME  = 'hhuijkyxkunm';
const REPO_BRANCH = 'main';
const REPO_LUA_DIR = 'lua';

// ===== args =====
function arg(name) {
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--' + name + '=')) return process.argv[i].split('=')[1];
    if (process.argv[i] === '--' + name && process.argv[i + 1]) return process.argv[++i];
  }
  return null;
}
const LUA_DIR      = path.resolve(arg('lua-dir') || process.env.LUA_DIR || path.join(__dirname, 'lua'));
const GITHUB_TOKEN = arg('github-token') || process.env.GITHUB_TOKEN || '';
const PROXY_URL    = arg('proxy') || process.env.STEAM_PROXY || '';
const OUT_JSON     = path.join(LUA_DIR, '_check-result.json');

// ===== GitHub helpers =====
function ghGet(pathUrl, accept) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: pathUrl,
      method: 'GET',
      headers: {
        'User-Agent': 'hhuijk-check/2.0',
        'Accept': accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(GITHUB_TOKEN ? { 'Authorization': 'Bearer ' + GITHUB_TOKEN } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode >= 400) return reject(new Error(`GitHub ${res.statusCode}: ${body.slice(0, 200)}`));
        resolve(JSON.parse(body));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchRemoteLuaList() {
  const url = `/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${REPO_BRANCH}?recursive=1`;
  const data = await ghGet(url);
  if (!data || !data.tree) throw new Error('Invalid tree response');
  return data.tree.filter(f =>
    f.type === 'blob' &&
    f.path.startsWith(REPO_LUA_DIR + '/') &&
    f.path.endsWith('.lua')
  );
}

async function fetchRemoteLuaContent(remotePath) {
  // Use contents API for single file — returns base64 encoded content
  const apiPath = `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(remotePath)}?ref=${REPO_BRANCH}`;
  const data = await ghGet(apiPath);
  if (!data.content) throw new Error('No content field in response');
  // GitHub contents API base64 has \n line breaks
  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
}

// ===== HTTP Store API =====
function http(hostname, urlPath, timeout = 10000, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: urlPath, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': 'wants_mature_content=1; birthtime=0; lastagecheckage=1-0-1990; steamCountry=HK',
        ...headers,
      },
      rejectUnauthorized: false,
      timeout,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const loc = new URL(res.headers.location, `https://${hostname}`);
        http(loc.hostname, loc.pathname + loc.search, timeout, headers).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

async function fetchStoreInfoTwice(appId) {
  const oneShot = async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const data = await http('store.steampowered.com',
          `/api/appdetails?appids=${appId}&l=schinese&cc=hk`, 8000);
        const json = JSON.parse(data);
        const info = json[appId];
        if (info && info.success && info.data) return { ok: true, data: info.data };
      } catch (_) {}
      await new Promise(r => setTimeout(r, 400 * attempt));
    }
    return { ok: false };
  };
  const a = await oneShot();
  await new Promise(r => setTimeout(r, 600));
  const b = await oneShot();

  if (!a.ok && !b.ok) return { ok: false };

  // merge DLC lists
  const dlcA = a.ok && a.data.dlc ? a.data.dlc : [];
  const dlcB = b.ok && b.data.dlc ? b.data.dlc : [];
  const mergedDlc = [...new Set([...dlcA, ...dlcB])];
  const base = (dlcA.length >= dlcB.length ? a.data : b.data) || {};
  base.dlc = mergedDlc;

  return { ok: true, data: base, successRate: (a.ok ? 1 : 0) + (b.ok ? 1 : 0) };
}

// ===== SteamUser =====
let SteamUser;
try { SteamUser = require('steam-user'); } catch (e) { /* not available */ }

function createSteamClient() {
  const opts = { enablePicsCache: false, autoRelogin: false };
  if (PROXY_URL) {
    if (PROXY_URL.startsWith('socks')) opts.socksProxy = PROXY_URL;
    else opts.httpProxy = PROXY_URL;
  }
  return new SteamUser(opts);
}

function loginSteam() {
  return new Promise((resolve) => {
    if (!SteamUser) return resolve({ ok: false, reason: 'steam-user not installed' });
    const client = createSteamClient();
    const done = (ok, reason) => {
      clearTimeout(t);
      if (ok) resolve({ ok: true, client });
      else { try { client.logOff(); } catch (_) {} resolve({ ok: false, reason }); }
    };
    const t = setTimeout(() => done(false, 'timeout(20s)'), 20000);
    client.once('loggedOn', () => done(true));
    client.once('error', (e) => done(false, String(e.message || e)));
    client.once('debug', () => {}); // silence
    try { client.logOn({ anonymous: true }); } catch (e) { done(false, String(e.message)); }
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
  await new Promise(r => setTimeout(r, 500));
  const b = await getDepotIds(client, appId);
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

// ===== parse lua content =====
function parseLuaIds(content) {
  const ids = new Set();
  let m;
  const reApp = /addappid\s*\(\s*(\d+)/g;
  while ((m = reApp.exec(content)) !== null) ids.add(Number(m[1]));
  const reToken = /addtoken\s*\(\s*(\d+)/g;
  while ((m = reToken.exec(content)) !== null) ids.add(Number(m[1]));
  return ids;
}

// ===== main =====
async function main() {
  console.log('========================================');
  console.log('GitHub Lua integrity checker (v2)');
  console.log('Repo:', REPO_OWNER + '/' + REPO_NAME, REPO_BRANCH);
  console.log('Local:', LUA_DIR);
  console.log('GitHub Token:', GITHUB_TOKEN ? 'yes' : 'NO');
  console.log('Steam Proxy:', PROXY_URL || 'direct');
  console.log('SteamUser:', SteamUser ? SteamUser.version || 'installed' : 'NOT installed');
  console.log('========================================\n');

  // ---- 1. GitHub list ----
  console.log('[1/4] Fetching repo tree from GitHub...');
  let remoteTree;
  try {
    remoteTree = await fetchRemoteLuaList();
    console.log(`  Found ${remoteTree.length} .lua files on GitHub\n`);
  } catch (e) {
    console.error('  FATAL:', e.message);
    process.exit(1);
  }

  // ---- 2. Steam login ----
  let steamClient = null;
  let steamOk = false;
  console.log('[2/4] Steam anonymous login...');
  try {
    const r = await loginSteam();
    if (r.ok) {
      steamClient = r.client;
      steamOk = true;
      console.log('  OK\n');
    } else {
      console.log('  SKIP:', r.reason, '(will use Store API only)\n');
    }
  } catch (e) {
    console.log('  SKIP:', e.message, '\n');
  }

  // ---- 3. Local files ----
  console.log('[3/4] Scanning local directory...');
  let localFiles = [];
  if (fs.existsSync(LUA_DIR)) {
    localFiles = fs.readdirSync(LUA_DIR).filter(f => f.endsWith('.lua'));
  }
  const localSet = new Set(localFiles);
  console.log(`  Local .lua: ${localFiles.length}\n`);

  // ---- 4. Per-file check ----
  console.log('[4/4] Fetching + comparing each file...\n');

  const results = [];
  const summary = {
    total: remoteTree.length,
    ok: 0, missing: 0, extra: 0, error: 0,
    missingTotal: 0, extraTotal: 0,
    localOnly: 0,
    steamWorks: steamOk,
  };

  for (let idx = 0; idx < remoteTree.length; idx++) {
    const remote = remoteTree[idx];
    const fileName = remote.name || path.basename(remote.path);
    const appId = fileName.replace(/\.lua$/, '');
    const remotePath = remote.path; // "lua/12345.lua"

    const tag = `[${idx + 1}/${remoteTree.length}]`;

    if (isNaN(appId)) {
      console.log(`${tag} SKIP ${fileName} (not a numeric appid)`);
      continue;
    }

    try {
      // 4a. Fetch remote lua content
      let remoteContent;
      try {
        remoteContent = await fetchRemoteLuaContent(remotePath);
      } catch (e) {
        console.log(`${tag} ${appId} ❌ GitHub fetch failed: ${e.message}`);
        summary.error++;
        results.push({ mainAppId: appId, status: 'error', error: 'GitHub fetch: ' + e.message });
        continue;
      }

      // 4b. Local file exists?
      const localPath = path.join(LUA_DIR, fileName);
      const localExists = fs.existsSync(localPath);
      let localContent = '';
      if (localExists) localContent = fs.readFileSync(localPath, 'utf-8');

      // 4c. Parse IDs from both
      const remoteIds = parseLuaIds(remoteContent);
      const localIds = localExists ? parseLuaIds(localContent) : new Set();

      // 4d. Get "real" IDs (steam-user depots + Store API DLC)
      let realIds = new Set([Number(appId)]);
      let depotCount = 0;
      let dlcCount = 0;
      let steamOkForThis = false;
      let storeOk = false;
      let storeSuccessRate = 0;

      // steam-user depots (twice, merge)
      if (steamOk) {
        const depots = await getDepotIdsTwice(steamClient, Number(appId));
        depots.forEach(d => realIds.add(d));
        depotCount = depots.length;
        steamOkForThis = depots.length > 0;
        // Also check depots for each DLC
      }

      // Store API (DLC list, twice, merge)
      const storeRes = await fetchStoreInfoTwice(appId);
      if (storeRes.ok) {
        storeOk = true;
        storeSuccessRate = storeRes.successRate;
        const dlcs = storeRes.data.dlc || [];
        dlcs.forEach(d => realIds.add(Number(d)));
        dlcCount = dlcs.length;
      }

      // 4e. Compare remote vs real
      const missingInRemote = [...realIds].filter(id => !remoteIds.has(id)).sort((a, b) => a - b);
      const extraInRemote   = [...remoteIds].filter(id => !realIds.has(id) && id !== Number(appId)).sort((a, b) => a - b);
      const missingInLocal   = [...remoteIds].filter(id => !localIds.has(id)).sort((a, b) => a - b);
      const extraInLocal    = [...localIds].filter(id => !remoteIds.has(id) && id !== Number(appId)).sort((a, b) => a - b);

      // 4f. Determine status
      let status = 'ok';
      if (!storeOk && !steamOkForThis) status = 'error';
      else if (missingInRemote.length > 0) status = 'missing';
      else if (extraInRemote.length > 0) status = 'extra';

      if (status === 'ok') summary.ok++;
      else if (status === 'missing') summary.missing++;
      else if (status === 'extra') summary.extra++;
      else summary.error++;
      summary.missingTotal += missingInRemote.length;
      summary.extraTotal += extraInRemote.length;

      // 4g. Print
      const icon = status === 'ok' ? '✅' : status === 'missing' ? '⚠️' : status === 'extra' ? '⚠️' : '❌';
      const st = storeSuccessRate === 2 ? 'storex2' : storeSuccessRate === 1 ? 'storex1' : storeOk ? 'storex?' : 'storex0';
      const sm = steamOk ? `steam=${depotCount}` : '';
      console.log(`${tag} ${icon} ${appId} ${st} ${sm} dlc=${dlcCount} remote=${remoteIds.size} real=${realIds.size}`);
      if (missingInRemote.length > 0) console.log(`    missing in remote: ${missingInRemote.join(', ')}`);
      if (extraInRemote.length > 0)   console.log(`    extra in remote:   ${extraInRemote.join(', ')}`);
      if (!localExists) console.log(`    ⚠️  local file NOT FOUND: ${localPath}`);
      else if (missingInLocal.length > 0 || extraInLocal.length > 0) {
        console.log(`    local differs from remote: missing=${missingInLocal.length} extra=${extraInLocal.length}`);
      }

      results.push({
        mainAppId: appId, status,
        localExists,
        remoteCount: remoteIds.size, localCount: localIds.size,
        depotCount, dlcCount, storeSuccessRate,
        remoteIds: [...remoteIds].sort((a, b) => a - b),
        realIds: [...realIds].sort((a, b) => a - b),
        missingInRemote, extraInRemote,
        missingInLocal, extraInLocal,
      });

      // small delay between files
      await new Promise(r => setTimeout(r, 300));

    } catch (e) {
      console.log(`${tag} ❌ ${appId}: ${e.message}`);
      summary.error++;
      results.push({ mainAppId: appId, status: 'error', error: e.message });
    }
  }

  // Local-only files (exist locally but NOT on GitHub)
  const remoteNames = new Set(remoteTree.map(r => r.name));
  const localOnly = localFiles.filter(f => !remoteNames.has(f));
  summary.localOnly = localOnly.length;

  // ---- 5. Final summary ----
  console.log('\n========================================');
  console.log(`RESULTS: ${summary.total} files checked`);
  console.log(`  ✅ OK:         ${summary.ok}`);
  console.log(`  ⚠️ Missing:    ${summary.missing} (remote file is missing depots/DLC)`);
  console.log(`  ⚠️ Extra:      ${summary.extra} (remote file has IDs not in real data)`);
  console.log(`  ❌ Error:      ${summary.error}`);
  console.log(`  📦 Total missing IDs in remote: ${summary.missingTotal}`);
  console.log(`  🗑️  Total extra IDs in remote:   ${summary.extraTotal}`);
  console.log(`  📁 Local-only files: ${summary.localOnly}`);
  if (summary.localOnly > 0) {
    localOnly.forEach(f => console.log(`    - ${f}`));
  }
  console.log('========================================');

  // ---- 6. Save JSON ----
  const out = {
    timestamp: new Date().toISOString(),
    repo: `${REPO_OWNER}/${REPO_NAME}`,
    branch: REPO_BRANCH,
    summary,
    localOnly,
    results,
  };
  try {
    fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
    console.log(`\n📝 Report saved: ${OUT_JSON}`);
  } catch (e) {
    console.log('\n⚠️  Cannot write report:', e.message);
  }

  try { steamClient && steamClient.logOff(); } catch (_) {}
  process.exit(summary.error > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
