import { spawnSync } from "node:child_process";
import { extname, join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";

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
  ".prisma",
  ".txt",
  ".env",
  ".sh",
  ".ps1",
]);

const fixedTextFiles = new Set([".editorconfig", ".gitattributes"]);
const fallbackIgnoreDirs = new Set([".git", "node_modules", "dist", "coverage"]);

const requiredTokens = {
  "apps/api/public/index.html": [
    "库存管理系统",
    "登录系统",
    "店铺管理",
  ],
  "apps/api/public/app.js": ["showErrorModal", "normalizeErrorMessage", "openShopManageModal"],
};

const mojibakeRegex = /[｡-ﾟ]/g;

function isTextFile(file) {
  const normalizedFile = String(file).replace(/^\.\//, "");
  const fileName = normalizedFile.split("/").pop() || normalizedFile;
  if (fixedTextFiles.has(normalizedFile) || fixedTextFiles.has(fileName)) return true;
  if (fileName.startsWith(".env")) return true;
  return textExtensions.has(extname(normalizedFile).toLowerCase());
}

function listTrackedFiles() {
  try {
    const result = spawnSync("git", ["-c", "core.quotepath=false", "ls-files", "-z"], {
      encoding: "buffer",
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const stderr = decoder.decode(result.stderr ?? new Uint8Array());
      throw new Error(`git ls-files failed: ${stderr.trim() || `exit code ${result.status}`}`);
    }

    const output = decoder.decode(result.stdout ?? new Uint8Array());
    return output
      .split("\u0000")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter(isTextFile);
  } catch (error) {
    if (!isGitSpawnBlocked(error)) {
      throw error;
    }
    return listTextFilesFromFilesystem(".");
  }
}

function isGitSpawnBlocked(error) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code || "") : "";
  const syscall = "syscall" in error ? String(error.syscall || "") : "";
  return code === "EPERM" && syscall.includes("spawnSync");
}

function listTextFilesFromFilesystem(rootDir) {
  const files = [];
  walkTextFiles(rootDir, files);
  return files;
}

function walkTextFiles(currentDir, files) {
  const entries = readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (fallbackIgnoreDirs.has(entry.name)) {
        continue;
      }
      walkTextFiles(join(currentDir, entry.name), files);
      continue;
    }

    const relativePath = join(currentDir, entry.name).replaceAll("\\", "/").replace(/^\.\//, "");
    if (isTextFile(relativePath)) {
      files.push(relativePath);
    }
  }
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
