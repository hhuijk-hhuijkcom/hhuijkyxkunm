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
// ======================================================

// 创建lua输出目录
if (!fs.existsSync(OUTPUT_FOLDER)) fs.mkdirSync(OUTPUT_FOLDER, { recursive: true });

// 加载token映射
const tokenDict = JSON.parse(fs.readFileSync(PATH_TOKEN_JSON, "utf8"));
// 加载全部appid列表
const allIdList = fs.readFileSync(PATH_APPIDS_TXT, "utf8")
    .split("\n")
    .map(item => item.trim())
    .filter(item => /^\d+$/.test(item))
    .map(Number);

// 读取断点
let startIndex = 0;
if (fs.existsSync(PATH_PROGRESS)) {
    const content = fs.readFileSync(PATH_PROGRESS, "utf8").trim();
    if (/^\d+$/.test(content)) startIndex = parseInt(content);
}

// 读取失败清单
let failedIds = [];
if (fs.existsSync(PATH_FAILED)) {
    failedIds = fs.readFileSync(PATH_FAILED, "utf8")
        .split("\n")
        .map(item => item.trim())
        .filter(item => /^\d+$/.test(item))
        .map(Number);
}

// 企业微信推送
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

// 保存失败清单
function saveFailedList() {
    fs.writeFileSync(PATH_FAILED, [...new Set(failedIds)].join("\n"), "utf8");
}

// 移除失败id（成功生成之后）
function removeFailedId(appid) {
    failedIds = failedIds.filter(v => v !== appid);
    saveFailedList();
    console.log(`✅【${appid}】生成成功，从失败列表移除`);
}

// 单个app处理核心函数
async function handleSingleApp(mainAppId) {
    let tryCount = 0;
    let ok = false;
    while (tryCount < MAX_RETRY_TIMES && !ok) {
        tryCount++;
        console.log(`\n[${tryCount}/${MAX_RETRY_TIMES}] 请求主AppID: ${mainAppId}`);
        try {
            const steam = new SteamUser();
            steam.logOn({ anonymous: true });
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
            // DLC = 总列表排除主appid + 排除所有depot
            const dlcIdArr = allIdList.filter(id => id !== mainAppId && !depotIdArr.includes(id));

            const outputLines = [];
            // 主游戏
            outputLines.push(`--主游戏APPID: ${mainAppId}`);
            const mainToken = tokenDict[String(mainAppId)];
            if (mainToken) {
                outputLines.push(`addappid(${mainAppId},0,"${mainToken}")  -- 主游戏`);
            }
            outputLines.push("");

            // Depot区块（只有存在token才输出）
            outputLines.push("--depotsID");
            for (const depId of depotIdArr) {
                const depToken = tokenDict[String(depId)];
                if (depToken) {
                    outputLines.push(`addappid(${depId},0,"${depToken}")`);
                }
            }
            outputLines.push("");

            // DLC区块：全部直接输出addappid(id)，无需token
            outputLines.push("--无仓库DLC");
            for (const dlcId of dlcIdArr) {
                outputLines.push(`addappid(${dlcId})`);
            }

            // 写入文件 lua/主ID.lua
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

// 主执行入口
(async function main() {
    console.log(`📌 当前断点索引: ${startIndex}`);
    console.log(`⚠️ 待重试失败ID数量: ${failedIds.length}`);

    // 第一阶段：优先重试失败列表
    if (failedIds.length > 0) {
        console.log("\n============== 开始重试失败ID ==============");
        const copyFailed = [...failedIds];
        for (const appid of copyFailed) {
            await handleSingleApp(appid);
        }
        console.log("============== 失败ID重试结束 ==============\n");
    }

    // 第二阶段：正常批量任务
    const endIdx = Math.min(startIndex + BATCH_LIMIT, allIdList.length);
    const taskSlice = allIdList.slice(startIndex, endIdx);
    console.log(`📦 本轮正常任务数量：${taskSlice.length}，起始索引 ${startIndex} → ${endIdx}`);

    for (let i = 0; i < taskSlice.length; i++) {
        const appId = taskSlice[i];
        const globalIndex = startIndex + i;
        console.log(`\n【全局索引 ${globalIndex}/${allIdList.length - 1}】处理AppID:${appId}`);
        await handleSingleApp(appId);
        // 更新断点
        fs.writeFileSync(PATH_PROGRESS, String(globalIndex + 1), "utf8");
    }

    await sendMsg(`🤖本轮任务执行完毕！起始索引${startIndex}，结束索引${endIdx}`);
    console.log("\n🏁本轮全部任务执行结束！");
})();
