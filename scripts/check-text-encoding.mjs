import { execSync } from "node:child_process";
import { extname } from "node:path";
import { readFileSync } from "node:fs";

const decoder = new TextDecoder("utf-8", { fatal: true });

const textExtensions = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".css",
  ".html",
  ".sql",
  ".txt",
  ".env",
  ".sh",
  ".ps1",
]);

const fixedTextFiles = new Set([".editorconfig", ".gitattributes"]);

const requiredTokens = {
  "apps/api/public/index.html": [
    "库存管理系统",
    "登录系统",
    "店铺管理",
    "输入任意 型号 / SKU / ASIN / FNSKU / FBMSKU / RBSKU",
  ],
  "apps/api/public/app.js": ["showErrorModal", "normalizeErrorMessage", "openShopManageModal"],
};

const mojibakeRegex = /[｡-ﾟ]/g;

function isTextFile(file) {
  if (fixedTextFiles.has(file)) return true;
  return textExtensions.has(extname(file).toLowerCase());
}

function listTrackedFiles() {
  const output = execSync("git ls-files", { encoding: "utf8" });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isTextFile);
}

const issues = [];
const files = listTrackedFiles();

for (const file of files) {
  const data = readFileSync(file);

  try {
    decoder.decode(data);
  } catch (error) {
    issues.push(`[utf8] ${file} 不是有效的 UTF-8：${error.message}`);
    continue;
  }

  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    issues.push(`[bom] ${file} 包含 UTF-8 BOM，请移除以避免运行时/迁移异常`);
  }

  const text = data.toString("utf8");
  if (text.includes("\uFFFD")) {
    issues.push(`[replacement] ${file} 包含 Unicode 替换字符 U+FFFD，可能已发生乱码`);
  }

  if (file.startsWith("apps/api/public/") || file.startsWith(".github/workflows/")) {
    if (mojibakeRegex.test(text)) {
      issues.push(`[mojibake] ${file} 包含半角片假名字符，疑似乱码`);
    }
    mojibakeRegex.lastIndex = 0;
  }

  const tokens = requiredTokens[file];
  if (tokens?.length) {
    for (const token of tokens) {
      if (!text.includes(token)) {
        issues.push(`[copy] ${file} 缺少关键文案或标识：${token}`);
      }
    }
  }
}

if (issues.length) {
  console.error("文本编码检查失败：");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log(`文本编码检查通过，共检查 ${files.length} 个文本文件。`);
