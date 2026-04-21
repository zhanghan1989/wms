"use strict";

const { execFile } = require("child_process");
const { randomUUID } = require("crypto");
const { existsSync, readFileSync } = require("fs");
const { mkdir, rm, writeFile } = require("fs/promises");
const os = require("os");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const listPrintersOnly = process.argv.includes("--list-printers");
const runtimeDir = process.pkg ? path.dirname(process.execPath) : __dirname;

const WINDOWS_PRINT_SCRIPT = String.raw`
param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath,

  [Parameter(Mandatory = $false)]
  [string]$PrinterName,

  [Parameter(Mandatory = $false)]
  [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $FilePath)) {
  throw "Print file not found: $FilePath"
}

$timeoutMs = [Math]::Max($TimeoutSeconds, 5) * 1000
if ([string]::IsNullOrWhiteSpace($PrinterName)) {
  $printerName = $null
} else {
  $printerName = $PrinterName.Trim()
}

if ($printerName) {
  $process = Start-Process -FilePath $FilePath -Verb PrintTo -ArgumentList ('"{0}"' -f $printerName) -PassThru -WindowStyle Hidden
  $verb = "printto"
} else {
  $process = Start-Process -FilePath $FilePath -Verb Print -PassThru -WindowStyle Hidden
  $verb = "print"
}

if ($process) {
  $null = $process.WaitForExit($timeoutMs)
  if (-not $process.HasExited) {
    try {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    } catch {
    }
  }
  Write-Output ("windows-{0}-{1}" -f $verb, $process.Id)
} else {
  Write-Output ("windows-{0}" -f $verb)
}
`;

function loadEnvFile(filePath) {
  let content = "";
  try {
    content = readFileSync(filePath, "utf8");
  } catch (_) {
    return;
  }

  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) {
      return;
    }
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  });
}

loadEnvFile(path.join(runtimeDir, ".env"));

const baseUrl = String(process.env.WMS_BASE_URL || "").trim().replace(/\/+$/, "");
const apiKey = String(process.env.PRINT_AGENT_API_KEY || "").trim();
const agentName = String(process.env.PRINT_AGENT_NAME || "").trim() || os.hostname() || "print-agent";
const pollIntervalMs = Math.max(Number(process.env.PRINT_AGENT_POLL_INTERVAL_MS || 2000) || 2000, 500);
const defaultPrinterName = String(process.env.PRINT_AGENT_DEFAULT_PRINTER_NAME || "").trim();
const windowsPdfToolPath = String(process.env.PRINT_AGENT_WINDOWS_PDF_TOOL_PATH || "").trim();
const printerNames = String(process.env.PRINT_AGENT_PRINTERS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const windowsPrintTimeoutSec = Math.max(
  Number(process.env.PRINT_AGENT_WINDOWS_PRINT_TIMEOUT_SEC || 20) || 20,
  5,
);

if (!baseUrl && !listPrintersOnly) {
  console.error("[print-agent] Missing WMS_BASE_URL");
  process.exit(1);
}
if (!apiKey && !listPrintersOnly) {
  console.error("[print-agent] Missing PRINT_AGENT_API_KEY");
  process.exit(1);
}

function log(message) {
  console.log(`[print-agent] ${new Date().toISOString()} ${message}`);
}

function truncateOptionalText(value, maxLength) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function resolveRuntimePath(filePath) {
  if (!filePath) {
    return "";
  }
  return path.isAbsolute(filePath) ? filePath : path.join(runtimeDir, filePath);
}

function getWindowsPdfToolPath() {
  if (process.platform !== "win32") {
    return "";
  }
  const candidates = [
    resolveRuntimePath(windowsPdfToolPath),
    path.join(runtimeDir, "SumatraPDF.exe"),
    path.join(runtimeDir, "sumatrapdf.exe"),
    String.raw`C:\Program Files\SumatraPDF\SumatraPDF.exe`,
    String.raw`C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe`,
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

async function listWindowsPrinters() {
  const command = [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-Printer | Sort-Object Name | ForEach-Object { $_.Name }",
  ];
  try {
    const { stdout } = await execFileAsync("powershell.exe", command, {
      windowsHide: true,
    });
    return String(stdout || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  } catch (error) {
    const stderr = String(error && error.stderr ? error.stderr : "").trim();
    const stdout = String(error && error.stdout ? error.stdout : "").trim();
    const message = stderr || stdout || (error instanceof Error ? error.message : "failed to list Windows printers");
    throw new Error(`Unable to list Windows printers: ${message}`);
  }
}

async function resolveWindowsPrinterName(printerName) {
  const requestedName = String(printerName || "").trim();
  if (!requestedName || process.platform !== "win32") {
    return requestedName;
  }

  const printers = await listWindowsPrinters();
  const exactMatch = printers.find((name) => name === requestedName);
  if (exactMatch) {
    return exactMatch;
  }

  const caseInsensitiveMatch = printers.find((name) => name.toLowerCase() === requestedName.toLowerCase());
  if (caseInsensitiveMatch) {
    return caseInsensitiveMatch;
  }

  throw new Error(
    `Printer "${requestedName}" was not found on this Windows machine. Available printers: ${printers.join(", ") || "(none)"}`,
  );
}

async function requestJson(pathname, options = {}) {
  const headers = {
    "x-print-agent-key": apiKey,
    ...(options.headers || {}),
  };
  const response = await fetch(`${baseUrl}/api${pathname}`, {
    ...options,
    headers,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_) {}
  if (!response.ok) {
    const message = payload && payload.message ? payload.message : text || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload && Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
}

async function downloadJobFile(jobId, claimToken) {
  const response = await fetch(
    `${baseUrl}/api/print-agent/jobs/${encodeURIComponent(jobId)}/file?claimToken=${encodeURIComponent(claimToken)}`,
    {
      headers: {
        "x-print-agent-key": apiKey,
      },
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Download failed: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function claimNextJob() {
  return requestJson("/print-agent/jobs/claim-next", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agentName,
      printerNames,
    }),
  });
}

async function reportComplete(job, printerName, systemJobId) {
  await requestJson(`/print-agent/jobs/${encodeURIComponent(job.id)}/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      claimToken: job.claimToken,
      printerName: truncateOptionalText(printerName, 128),
      systemJobId: truncateOptionalText(systemJobId, 128),
    }),
  });
}

async function reportFailure(job, errorMessage) {
  await requestJson(`/print-agent/jobs/${encodeURIComponent(job.id)}/fail`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      claimToken: job.claimToken,
      errorMessage: String(errorMessage || "").slice(0, 255),
    }),
  });
}

async function sendPdfToPrinter(job, pdfBuffer) {
  const requestedPrinterName = String(job.printerName || "").trim() || defaultPrinterName || "";
  const tempDir = path.join(os.tmpdir(), "wms-print-agent", randomUUID());
  const fileName = String(job.fileName || "yamato-label.pdf").replace(/[^A-Za-z0-9._-]+/g, "_");
  const tempFilePath = path.join(tempDir, fileName || "yamato-label.pdf");
  const scriptFilePath = path.join(tempDir, "print-pdf-windows.ps1");
  await mkdir(tempDir, { recursive: true });
  await writeFile(tempFilePath, pdfBuffer);
  await writeFile(scriptFilePath, WINDOWS_PRINT_SCRIPT, "utf8");

  try {
    if (process.platform === "win32") {
      const printerName = await resolveWindowsPrinterName(requestedPrinterName);
      const pdfToolPath = getWindowsPdfToolPath();
      if (pdfToolPath) {
        const args = printerName
          ? ["-silent", "-print-to", printerName, tempFilePath]
          : ["-silent", "-print-to-default", tempFilePath];
        try {
          const { stdout, stderr } = await execFileAsync(pdfToolPath, args, {
            windowsHide: true,
          });
          const output = String(stdout || stderr || "").trim();
          return {
            printerName: printerName || null,
            systemJobId: output || `sumatra-${path.basename(pdfToolPath)}`,
          };
        } catch (error) {
          const stderr = String(error && error.stderr ? error.stderr : "").trim();
          const stdout = String(error && error.stdout ? error.stdout : "").trim();
          const message = stderr || stdout || (error instanceof Error ? error.message : "SumatraPDF print failed");
          throw new Error(
            `SumatraPDF print failed: ${message}. Confirm PRINT_AGENT_WINDOWS_PDF_TOOL_PATH and printer name match Windows settings.`,
          );
        }
      }
      const args = [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptFilePath,
        "-FilePath",
        tempFilePath,
      ];
      if (printerName) {
        args.push("-PrinterName", printerName);
      }
      args.push(
        "-TimeoutSeconds",
        String(windowsPrintTimeoutSec),
      );
      try {
        const { stdout, stderr } = await execFileAsync("powershell.exe", args, {
          windowsHide: true,
        });
        const output = String(stdout || stderr || "").trim();
        return {
          printerName: printerName || null,
          systemJobId: output || null,
        };
      } catch (error) {
        const stderr = String(error && error.stderr ? error.stderr : "").trim();
        const stdout = String(error && error.stdout ? error.stdout : "").trim();
        const message = stderr || stdout || (error instanceof Error ? error.message : "Windows print failed");
        if (/ENOENT|not found/i.test(message)) {
          throw new Error("powershell.exe not found on this Windows machine");
        }
        throw new Error(
          `Windows PDF print failed: ${message}. Install SumatraPDF.exe next to wms-print-agent.exe or set PRINT_AGENT_WINDOWS_PDF_TOOL_PATH, then confirm the printer name matches Windows settings.`,
        );
      }
    }

    const printerName = requestedPrinterName;
    const args = ["-t", String(job.fileName || "Yamato Label")];
    if (printerName) {
      args.push("-d", printerName);
    }
    args.push(tempFilePath);

    const { stdout, stderr } = await execFileAsync("lp", args);
    const output = String(stdout || stderr || "").trim();
    const match = output.match(/\b([^\s()]+-\d+)\b/);
    return {
      printerName: printerName || null,
      systemJobId: match ? match[1] : output || null,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function processOneJob() {
  const job = await claimNextJob();
  if (!job) {
    return false;
  }

  const targetPrinter = String(job.printerName || "").trim() || defaultPrinterName || "(system default)";
  log(`Claimed job #${job.id} for product ${job.productId}, printer ${targetPrinter}`);

  let step = "download";
  try {
    const pdfBuffer = await downloadJobFile(job.id, job.claimToken);
    step = "print";
    const printResult = await sendPdfToPrinter(job, pdfBuffer);
    step = "complete";
    await reportComplete(job, printResult.printerName, printResult.systemJobId);
    log(`Completed job #${job.id}${printResult.systemJobId ? ` (${printResult.systemJobId})` : ""}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown print error";
    try {
      await reportFailure(job, message);
    } catch (reportError) {
      log(`Failed to report error for job #${job.id}: ${reportError instanceof Error ? reportError.message : String(reportError)}`);
    }
    log(`Job #${job.id} failed during ${step}: ${message}`);
    return true;
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  log(`Started with base URL ${baseUrl}`);
  const windowsPdfTool = getWindowsPdfToolPath();
  log(`Print platform: ${process.platform === "win32" ? (windowsPdfTool ? "windows-sumatrapdf" : "windows-shell") : "lp"}`);
  if (windowsPdfTool) {
    log(`Windows PDF tool: ${windowsPdfTool}`);
  }
  if (process.platform === "win32") {
    try {
      const printers = await listWindowsPrinters();
      log(`Windows printers: ${printers.join(", ") || "(none)"}`);
      if (listPrintersOnly) {
        return;
      }
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
      if (listPrintersOnly) {
        process.exitCode = 1;
        return;
      }
    }
  }
  if (printerNames.length) {
    log(`Printer filter: ${printerNames.join(", ")}`);
  } else if (defaultPrinterName) {
    log(`Using default fallback printer: ${defaultPrinterName}`);
  } else {
    log("Using system default printer when job does not specify a printer");
  }

  while (true) {
    try {
      const processed = await processOneJob();
      await sleep(processed ? 300 : pollIntervalMs);
    } catch (error) {
      log(`Loop error: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(Math.max(pollIntervalMs, 3000));
    }
  }
}

main().catch((error) => {
  log(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
