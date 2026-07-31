const SteamUser = require("steam-user");
const fs = require("fs");
const path = require("path");
const https = require("https");

// ======================【配置区】======================
const PATH_APPIDS_TXT = "./appids.txt";
const PATH_TOKEN_JSON = "./appaccesstokens.json";
const PATH_DEPOTKEYS = "./depotkeys.json";
const PATH_PROGRESS = "./progress.txt";
const PATH_FAILED = "./failed_ids.txt";
const OUTPUT_FOLDER = "./lua"; // 修改输出目录为lua文件夹
const BATCH_LIMIT = 1000;
const MAX_RETRY = 3;
const WECOM_WEBHOOK = process.env.WECOM_WEBHOOK || "";
// =====================================================

if (!fs.existsSync(OUTPUT_FOLDER)) fs.mkdirSync(OUTPUT_FOLDER, { recursive: true });

// 加载密钥文件
const tokenMap = JSON.parse(fs.readFileSync(PATH_TOKEN_JSON, "utf8"));
const depotKeyMap = fs.existsSync(PATH_DEPOTKEYS) ? JSON.parse(fs.readFileSync(PATH_DEPOTKEYS, "utf8")) : {};

// 读取全部待处理主AppID列表
const allAppids = fs.readFileSync(PATH_APPIDS_TXT, "utf8")
    .split("\n")
    .map(s => s.trim())
    .filter(s => /^\d+$/.test(s))
    .map(Number);

// 读取断点
let startIndex = 0;
if (fs.existsSync(PATH_PROGRESS)) {
    const text = fs.readFileSync(PATH_PROGRESS, "utf8").trim();
    if (!isNaN(parseInt(text))) startIndex = parseInt(text);
}

// 读取失败清单（全局保存，成功后剔除）
let failedIdList = [];
if (fs.existsSync(PATH_FAILED)) {
    failedIdList = fs.readFileSync(PATH_FAILED, "utf8")
        .split("\n")
        .map(s => s.trim())
        .filter(s => /^\d+$/.test(s))
        .map(Number);
}

console.log(`📌 正常任务断点位置：从第 ${startIndex} 条开始处理`);
console.log(`⚠️ 待重试失败ID总数：${failedIdList.length}`);

// 企业微信推送
function sendWecomMsg(content) {
    if (!WECOM_WEBHOOK) return Promise.resolve();
    return new Promise((resolve) => {
        const postData = JSON.stringify({
            msgtype: "text",
            text: { content }
        });
        const req = https.request(WECOM_WEBHOOK, {
            method: "POST",
            headers: { "Content-Type": "application/json" }
        }, () => resolve());
        req.on("error", () => resolve());
        req.write(postData);
        req.end();
    });
}

// 将失败ID写入内存列表并持久化
function addFailedId(appid) {
    if (!failedIdList.includes(appid)) {
        failedIdList.push(appid);
        fs.writeFileSync(PATH_FAILED, failedIdList.join("\n") + "\n", "utf8");
    }
}

// ID成功后，从失败清单移除
function removeFailedId(appid) {
    if (failedIdList.includes(appid)) {
        failedIdList = failedIdList.filter(x => x !== appid);
        fs.writeFileSync(PATH_FAILED, failedIdList.join("\n") + "\n", "utf8");
        console.log(`✅ AppID【${appid}】执行成功，已从失败列表移除`);
    }
}

// 单个ID处理函数
async function handleSingleApp(mainAppId) {
    let tryCount = 0;
    let success = false;
    while (tryCount < MAX_RETRY && !success) {
        tryCount++;
        console.log(`▶ 主AppID ${mainAppId} 第${tryCount}/${MAX_RETRY}次尝试`);

        try {
            const appResult = await new Promise((resolve, reject) => {
                steamClient.getProductInfo([mainAppId], [], false, (err, data) => {
                    if (err) reject(err);
                    else resolve(data);
                });
            });

            const appInfo = appResult[mainAppId];
            const depotIds = Object.keys(appInfo.depots || {}).map(Number);
            const depotAppIds = depotIds;

            // 筛选DLC：appids.txt内，排除主ID、排除所有depotID
            const dlcList = allAppids.filter(id => {
                return id !== mainAppId && !depotAppIds.includes(id);
            });

            const lines = [];
            lines.push(`--主游戏APPID: ${mainAppId}`);
            const mainToken = tokenMap[String(mainAppId)];
            if (mainToken) {
                lines.push(`addappid(${mainAppId},0,"${mainToken}")  -- 主游戏`);
            }
            lines.push("");

            lines.push("--depotsID");
            for (const depId of depotAppIds) {
                const accessToken = tokenMap[String(depId)];
                if (accessToken) {
                    lines.push(`addappid(${depId},0,"${accessToken}")`);
                }
            }
            lines.push("");

            lines.push("--无仓库DLC");
            for (const dlcId of dlcList) {
                lines.push(`addappid(${dlcId})`);
            }

            // 文件输出路径 ./lua/主ID.lua
            const savePath = path.join(OUTPUT_FOLDER, `${mainAppId}.lua`);
            fs.writeFileSync(savePath, lines.join("\n"), "utf-8");
            success = true;
            console.log(`✅ ${mainAppId}.lua 生成完成，存放至lua文件夹`);
            removeFailedId(mainAppId);

        } catch (err) {
            console.error(`❌ ${mainAppId} 查询失败：${err.message}`);
            if (tryCount >= MAX_RETRY) {
                addFailedId(mainAppId);
                await sendWecomMsg(`❌ AppID【${mainAppId}】重试${MAX_RETRY}次仍然失败，保留在失败列表`);
            }
        }
        await new Promise(r => setTimeout(r, 1200));
    }
}

// Steam客户端
const steamClient = new SteamUser({
    enablePicsCache: false,
    autoRelogin: false
});
steamClient.logOn({ anonymous: true });

steamClient.on("error", async (err) => {
    console.error("Steam客户端连接异常：", err);
    await sendWecomMsg(`⚠️ Steam客户端发生全局错误：${err.message}`);
});

steamClient.on("loggedOn", async () => {
    console.log("✅ Steam匿名登录成功");

    // ========= 第一步：优先处理所有失败ID =========
    if (failedIdList.length > 0) {
        console.log("\n==================== 开始优先重试失败ID ====================");
        for (const appId of [...failedIdList]) {
            await handleSingleApp(appId);
        }
        console.log("==================== 失败ID全部处理完毕 ====================\n");
    } else {
        console.log("ℹ️ 暂无失败ID，直接执行正常任务");
    }

    // ========= 第二步：继续断点正常任务 =========
    const endIndex = Math.min(startIndex + BATCH_LIMIT, allAppids.length);
    const taskList = allAppids.slice(startIndex, endIndex);
    console.log(`📦 正常任务本次待处理数量：${taskList.length} 个AppID`);

    let currentTaskIndex = 0;
    async function processNormalTask() {
        if (currentTaskIndex >= taskList.length) {
            console.log("✅ 本批次全部任务执行完毕！");
            console.log(`🏁 下一轮正常任务从索引 ${startIndex + taskList.length} 开始`);
            setTimeout(() => process.exit(0), 2000);
            return;
        }
        const mainAppId = taskList[currentTaskIndex];
        console.log(`[${startIndex + currentTaskIndex}/${allAppids.length}]`);
        await handleSingleApp(mainAppId);

        // 更新断点
        const nextGlobalIndex = startIndex + currentTaskIndex + 1;
        fs.writeFileSync(PATH_PROGRESS, String(nextGlobalIndex), "utf8");
        currentTaskIndex++;
        processNormalTask();
    }
    await processNormalTask();
});
