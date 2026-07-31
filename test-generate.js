const fs = require("fs");
const path = require("path");

const OUTPUT_FOLDER = "./lua";
// 随便填一个测试主游戏ID
const TEST_APPID = 668580;

if (!fs.existsSync(OUTPUT_FOLDER)) {
    fs.mkdirSync(OUTPUT_FOLDER, { recursive: true });
}

const lines = [
    `--主游戏APPID: ${TEST_APPID}`,
    `addappid(${TEST_APPID},0,"5a1ed8d8d2a8110fde9be6e0ec543d96db83954f381710c70e330b5c010841e7")  -- 主游戏`,
    "",
    "--depotsID",
    `addappid(668581,0,"b331448756a6614f7b9b52f56b71e329928370afb8034b8474e264ace0048928")`,
    "",
    "--无仓库DLC",
    "addappid(2214824)",
    "addappid(2214823)"
];

const savePath = path.join(OUTPUT_FOLDER, `${TEST_APPID}.lua`);
fs.writeFileSync(savePath, lines.join("\n"), "utf8");
console.log(`✅ 测试文件生成成功：${savePath}`);
