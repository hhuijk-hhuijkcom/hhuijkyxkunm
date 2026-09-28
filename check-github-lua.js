const fs = require('fs');
const path = require('path');
const https = require('https');

// ===== config =====
const REPO_OWNER = 'hhuijk-hhuijkcom';
const REPO_NAME = 'hhuijkyxkunm';
const REPO_BRANCH = 'main';
const REPO_LUA_PATH = 'lua';

// ===== args =====
function getArg(name) {
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--' + name + '=')) return process.argv[i].split('=')[1];
    if (process.argv[i] === '--' + name && process.argv[i + 1]) return process.argv[++i];
  }
  return null;
}

let LUA_DIR = getArg('lua-dir') || process.env.LUA_DIR || path.join(__dirname, 'lua');
LUA_DIR = path.resolve(LUA_DIR);
const GITHUB_TOKEN = getArg('github-token') || process.env.GITHUB_TOKEN || '';
const OUT_JSON = path.join(LUA_DIR, '_github-check.json');
const OUT_TXT = path.join(LUA_DIR, '_github-check.txt');

// ===== github api =====
function ghRequest(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: urlPath,
      method: 'GET',
      headers: {
        'User-Agent': 'hhuijk-check/1.0',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(GITHUB_TOKEN ? { 'Authorization': 'Bearer ' + GITHUB_TOKEN } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        } else {
          try { resolve(JSON.parse(body)); }
          catch (_) { reject(new Error('Invalid JSON')); }
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function listRemoteLuaFiles() {
  const url = `/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${REPO_BRANCH}?recursive=1`;
  const data = await ghRequest(url);
  if (!data || !data.tree) throw new Error('Failed to get repo tree');
  return data.tree
    .filter(f => f.type === 'blob' && f.path.startsWith(REPO_LUA_PATH + '/') && f.path.endsWith('.lua'))
    .map(f => ({
      path: f.path,
      name: path.basename(f.path),
      appId: path.basename(f.path, '.lua'),
      sha: f.sha,
      size: f.size || 0,
    }));
}

function listLocalLuaFiles() {
  if (!fs.existsSync(LUA_DIR)) return [];
  return fs.readdirSync(LUA_DIR)
    .filter(f => f.endsWith('.lua'))
    .map(name => ({
      name,
      appId: name.replace(/\.lua$/, ''),
      fullPath: path.join(LUA_DIR, name),
      size: fs.statSync(path.join(LUA_DIR, name)).size,
    }));
}

// ===== main =====
async function main() {
  console.log('========================================');
  console.log('GitHub Lua sync check');
  console.log('Repo:', REPO_OWNER + '/' + REPO_NAME, REPO_BRANCH);
  console.log('Local:', LUA_DIR);
  console.log('Token:', GITHUB_TOKEN ? 'yes' : 'NO (public repo only)');
  console.log('========================================\n');

  // 1. remote
  console.log('Fetching remote lua files...');
  let remoteFiles = [];
  try {
    remoteFiles = await listRemoteLuaFiles();
    console.log(`Remote: ${remoteFiles.length} .lua files\n`);
  } catch (e) {
    console.error('ERROR:', e.message);
    console.error('If this is a private repo, provide --github-token=ghp_xxx');
    process.exit(1);
  }

  // 2. local
  const localFiles = listLocalLuaFiles();
  console.log(`Local: ${localFiles.length} .lua files\n`);

  // 3. compare
  const remoteMap = new Map();
  remoteFiles.forEach(f => remoteMap.set(f.appId, f));
  const localMap = new Map();
  localFiles.forEach(f => localMap.set(f.appId, f));

  const onlyRemote = [];
  const onlyLocal = [];
  const both = [];

  for (const [appId, rFile] of remoteMap) {
    if (localMap.has(appId)) {
      both.push({ appId, remote: rFile, local: localMap.get(appId) });
    } else {
      onlyRemote.push({ appId, remote: rFile });
    }
  }
  for (const [appId, lFile] of localMap) {
    if (!remoteMap.has(appId)) {
      onlyLocal.push({ appId, local: lFile });
    }
  }

  onlyRemote.sort((a, b) => Number(a.appId) - Number(b.appId));
  onlyLocal.sort((a, b) => Number(a.appId) - Number(b.appId));

  // 4. report
  console.log('========================================');
  console.log('RESULTS');
  console.log('========================================');
  if (onlyRemote.length > 0) {
    console.log(`\nMissing locally (${onlyRemote.length}):`);
    onlyRemote.forEach(f => console.log(`  + ${f.remote.name} (${f.remote.size || '?'} bytes)`));
  } else {
    console.log('\nAll remote files exist locally');
  }
  if (onlyLocal.length > 0) {
    console.log(`\nExtra locally (${onlyLocal.length}):`);
    onlyLocal.forEach(f => console.log(`  - ${f.local.name} (${f.local.size} bytes)`));
  } else {
    console.log('\nNo extra local files');
  }

  const match = remoteFiles.length === localFiles.length && onlyRemote.length === 0 && onlyLocal.length === 0;
  console.log(`\nSummary:`);
  console.log(`  Remote only: ${onlyRemote.length}`);
  console.log(`  Local only:  ${onlyLocal.length}`);
  console.log(`  Both:        ${both.length}`);
  console.log(`  Match:       ${match ? 'YES' : 'NO'}`);

  // 5. save json
  const summary = {
    timestamp: new Date().toISOString(),
    repo: `${REPO_OWNER}/${REPO_NAME}`,
    branch: REPO_BRANCH,
    remoteCount: remoteFiles.length,
    localCount: localFiles.length,
    missingLocally: onlyRemote.map(f => ({ appId: f.appId, name: f.remote.name, size: f.remote.size })),
    extraLocally: onlyLocal.map(f => ({ appId: f.appId, name: f.local.name, size: f.local.size })),
    match: match,
  };
  try {
    fs.writeFileSync(OUT_JSON, JSON.stringify(summary, null, 2));
    console.log(`\nJSON report: ${OUT_JSON}`);
  } catch (e) {
    console.log('\nCannot write JSON report:', e.message);
  }

  // 6. save txt
  const txtLines = [];
  txtLines.push('===== GitHub Lua Sync Report =====');
  txtLines.push('Time:     ' + new Date().toISOString());
  txtLines.push('Repo:     ' + REPO_OWNER + '/' + REPO_NAME + ' @ ' + REPO_BRANCH);
  txtLines.push('Local:    ' + LUA_DIR);
  txtLines.push('');
  txtLines.push('Remote .lua files: ' + remoteFiles.length);
  txtLines.push('Local  .lua files: ' + localFiles.length);
  txtLines.push('Match:             ' + (match ? 'YES' : 'NO'));
  txtLines.push('');
  txtLines.push('--- Missing locally (remote has, local no) ---');
  if (onlyRemote.length > 0) {
    onlyRemote.forEach(f => txtLines.push('  + ' + f.remote.name + '  (' + (f.remote.size || '?') + ' bytes)'));
  } else {
    txtLines.push('  (none)');
  }
  txtLines.push('');
  txtLines.push('--- Extra locally (local has, remote no) ---');
  if (onlyLocal.length > 0) {
    onlyLocal.forEach(f => txtLines.push('  - ' + f.local.name + '  (' + f.local.size + ' bytes)'));
  } else {
    txtLines.push('  (none)');
  }
  txtLines.push('');
  txtLines.push('--- Files on both sides ---');
  if (both.length > 0) {
    both.forEach(f => txtLines.push('  = ' + f.remote.name + '  (remote:' + (f.remote.size||'?') + ' / local:' + f.local.size + ')'));
  } else {
    txtLines.push('  (none)');
  }
  txtLines.push('');
  txtLines.push('================================');
  try {
    fs.writeFileSync(OUT_TXT, txtLines.join('\n'));
    console.log('TXT report:  ' + OUT_TXT);
  } catch (e) {
    console.log('Cannot write TXT report:', e.message);
  }

  console.log('========================================');

  // 有差异就 exit(1)，让 Actions 标红
  process.exit(match ? 0 : 1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
