const SteamUser = require("steam-user");
const fs = require("fs");
const path = require("path");
const https = require("https");

// ====================配置区====================
const PATH_APPIDS_TXT = "./appids.txt";
const PATH_TOKEN_JSON = "./appaccesstokens.json";
const OUTPUT_FOLDER = "./lua";
const TEST_MAIN_APPID = 668580;
const MAX_RETRY = 3;
const WECOM_WEBHOOK = process.env.WECOM_WEBHOOK || "";
// ==============================================

if (!fs.existsSync(OUTPUT_FOLDER)) fs.mkdirSync(OUTPUT_FOLDER, { recursive: true });

// 读取token映射
const tokenMap = JSON.parse(fs.readFileSync(PATH_TOKEN_JSON, "utf8"));
// 读取全部AppID（用于筛选DLC）
const allAppids = fs.readFileSync(PATH_APPIDS_TXT, "utf8")
    .split("\n")
    .map(s => s.trim())
    .filter(s => /^\d+$/.test(s))
    .map(Number);

// 企微消息
function sendWecomMsg(content) {
    if (!WECOM_WEBHOOK) return Promise.resolve();
    return new Promise(resolve => {
        const data = JSON.stringify({ msgtype: "text", text: { content } });
        const req = https.request(WECOM_WEBHOOK, { method:"POST", headers:{"Content-Type":"application/json"} }, ()=>resolve());
        req.on("error", ()=>resolve());
        req.write(data);
        req.end();
    });
}

async function runTask(appId) {
    let tryCount = 0;
    let success = false;
    while(tryCount < MAX_RETRY && !success){
        tryCount++;
        console.log(`尝试 ${tryCount}/${MAX_RETRY} AppID:${appId}`);
        try {
            const client = new SteamUser();
            client.logOn({anonymous:true});
            await new Promise((res,rej)=>{
                client.on("loggedOn",res);
                client.on("error",rej);
            });
            const info = await new Promise((res,rej)=>{
                client.getProductInfo([appId],[],(err,data)=> err ? rej(err):res(data));
            });
            client.logOff();

            const appInfo = info[appId];
            const depotIds = Object.keys(appInfo.depots || {}).map(Number);
            // DLC = 总列表排除主程序 + 排除所有depot
            const dlcList = allAppids.filter(id => id !== appId && !depotIds.includes(id));

            const lines = [];
            // ========= 主游戏 =========
            lines.push(`--主游戏APPID: ${appId}`);
            const mainToken = tokenMap[String(appId)];
            if(mainToken){
                lines.push(`addappid(${appId},0,"${mainToken}")  -- 主游戏`);
            }
            lines.push("");

            // ========= Depot（必须有token才输出） =========
            lines.push("--depotsID");
            for(const depId of depotIds){
                const dt = tokenMap[String(depId)];
                if(dt) {
                    lines.push(`addappid(${depId},0,"${dt}")`);
                }
            }
            lines.push("");

            // ========= DLC【不需要token，全部直接输出】 =========
            lines.push("--无仓库DLC");
            for(const d of dlcList){
                lines.push(`addappid(${d})`);
            }

            const savePath = path.join(OUTPUT_FOLDER, `${appId}.lua`);
            fs.writeFileSync(savePath, lines.join("\n"), "utf-8");
            console.log(`✅ 文件生成成功: ${savePath}`);
            await sendWecomMsg(`✅测试任务完成 AppID【${appId}】lua文件已生成`);
            success = true;
        } catch(err){
            console.error(`❌失败:${err.message}`);
            if(tryCount >= MAX_RETRY){
                await sendWecomMsg(`❌测试任务失败 AppID【${appId}】多次请求失败`);
            }
        }
        await new Promise(r=>setTimeout(r,1200));
    }
}

runTask(TEST_MAIN_APPID);
