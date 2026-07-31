const SteamUser = require("steam-user");
const fs = require("fs");
const path = require("path");
const https = require("https");

// ======================【配置区】======================
const PATH_APPIDS_TXT = "./appids.txt";
const PATH_TOKEN_JSON = "./appaccesstokens.json";
const PATH_PROGRESS = "./progress.txt";
const PATH_FAILED = "./failed_ids.txt";
const OUTPUT_FOLDER = "./lua";
const BATCH_LIMIT = 1000;
const MAX_RETRY_TIMES = 3;
const WEBHOOK = process.env.WECOM_WEBHOOK || "";
const TEST_APPID = 668580;
// ======================================================

// Steam账号从环境变量读取（绝对不要写死！）
const steamLoginInfo = {
    accountName: process.env.STEAM_ACCOUNT,
    password: process.env.STEAM_PASSWORD
};
// 如果存在令牌则加入
if(process.env.STEAM_GUARD && process.env.STEAM_GUARD.trim() !== ""){
    steamLoginInfo.steamGuardCode = process.env.STEAM_GUARD.trim();
}

if (!fs.existsSync(OUTPUT_FOLDER)) fs.mkdirSync(OUTPUT_FOLDER, { recursive: true });

const tokenDict = JSON.parse(fs.readFileSync(PATH_TOKEN_JSON, "utf8"));
const allIdList = fs.readFileSync(PATH_APPIDS_TXT, "utf8")
    .split("\n")
    .map(item => item.trim())
    .filter(item => /^\d+$/.test(item))
    .map(Number);

let startIndex = 0;
if (fs.existsSync(PATH_PROGRESS)) {
    const content = fs.readFileSync(PATH_PROGRESS, "utf8").trim();
    if (/^\d+$/.test(content)) startIndex = parseInt(content);
}

let failedIds = [];
if (fs.existsSync(PATH_FAILED)) {
    failedIds = fs.readFileSync(PATH_FAILED, "utf8")
        .split("\n")
        .map(item => item.trim())
        .filter(item => /^\d+$/.test(item))
        .map(Number);
}

function sendMsg(text) {
    if (!WEBHOOK) return Promise.resolve();
    return new Promise(resolve => {
        const payload = JSON.stringify({ msgtype: "text", text: { content: text } });
        const req = https.request(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" } }, () => resolve());
        req.on("error", () => resolve());
        req.write(payload);
        req.end();
    });
}

function saveFailedList() {
    fs.writeFileSync(PATH_FAILED, [...new Set(failedIds)].join("\n"), "utf8");
}

function removeFailedId(appid) {
    failedIds = failedIds.filter(v => v !== appid);
    saveFailedList();
    console.log(`✅【${appid}】生成成功，从失败列表移除`);
}

async function handleSingleApp(mainAppId) {
    let tryCount = 0;
    let ok = false;
    while (tryCount < MAX_RETRY_TIMES && !ok) {
        tryCount++;
        console.log(`\n[${tryCount}/${MAX_RETRY_TIMES}] 请求主AppID: ${mainAppId}`);
        try {
            const steam = new SteamUser();
            // 使用账号登录，不再匿名
            steam.logOn(steamLoginInfo);
            await new Promise((resolve, reject) => {
                steam.on("loggedOn", resolve);
                steam.on("error", reject);
            });
            const productData = await new Promise((resolve, reject) => {
                steam.getProductInfo([mainAppId], [], (err, data) => err ? reject(err) : resolve(data));
            });
            steam.logOff();

            const appInfo = productData[mainAppId];
            const depotIdArr = Object.keys(appInfo.depots || {}).map(Number);

            let dlcIdArr = [];
            if(depotIdArr.length === 0){
                console.warn(`⚠️【警告】AppID ${mainAppId} 获取Depot为空！本次不自动筛选DLC`);
                dlcIdArr = [];
            }else{
                dlcIdArr = allIdList.filter(id => id !== mainAppId && !depotIdArr.includes(id));
            }

            console.log("【调试信息】Depot清单：", depotIdArr);
            console.log("【调试信息】筛选出DLC清单：", dlcIdArr);

            const outputLines = [];
            outputLines.push(`--主游戏APPID: ${mainAppId}`);
            const mainToken = tokenDict[String(mainAppId)];
            if (mainToken) {
                outputLines.push(`addappid(${mainAppId},0,"${mainToken}")  -- 主游戏`);
            }
            outputLines.push("");

            outputLines.push("--depotsID");
            for (const depId of depotIdArr) {
                const depToken = tokenDict[String(depId)];
                if (depToken) {
                    outputLines.push(`addappid(${depId},0,"${depToken}")`);
                }
            }
            outputLines.push("");

            outputLines.push("--无仓库DLC");
            for (const dlcId of dlcIdArr) {
                outputLines.push(`addappid(${dlcId})`);
            }

            const targetPath = path.join(OUTPUT_FOLDER, `${mainAppId}.lua`);
            fs.writeFileSync(targetPath, outputLines.join("\n"), "utf8");
            console.log(`✅ 文件输出完成：${targetPath}`);
            removeFailedId(mainAppId);
            ok = true;
        } catch (err) {
            console.error(`❌ 请求异常 ${mainAppId} : ${err.message}`);
            if (tryCount >= MAX_RETRY_TIMES) {
                if (!failedIds.includes(mainAppId)) {
                    failedIds.push(mainAppId);
                    saveFailedList();
                }
                await sendMsg(`❌ AppID【${mainAppId}】多次请求失败，存入失败列表`);
            }
        }
        await new Promise(r => setTimeout(r, 1200));
    }
}

(async function main() {
    // 校验是否成功读取账号信息
    if(!steamLoginInfo.accountName || !steamLoginInfo.password){
        console.error("❌ 错误：未读取到STEAM_ACCOUNT/STEAM_PASSWORD环境变量，请检查仓库Secrets配置！");
        return;
    }
    console.log(`📌 当前断点索引: ${startIndex}`);
    console.log(`⚠️ 待重试失败ID数量: ${failedIds.length}`);

    // 调试模式
    console.log(`🧪【调试模式启动】测试AppID = ${TEST_APPID}`);
    await handleSingleApp(TEST_APPID);
    console.log(`🧪【调试模式结束】测试完成，直接终止程序，不运行批量任务`);
    return;
})();
