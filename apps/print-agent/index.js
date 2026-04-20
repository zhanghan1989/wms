"use strict";

const { execFile } = require("child_process");
const { randomUUID } = require("crypto");
const { mkdir, rm, writeFile } = require("fs/promises");
const os = require("os");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const baseUrl = String(process.env.WMS_BASE_URL || "").trim().replace(/\/+$/, "");
const apiKey = String(process.env.PRINT_AGENT_API_KEY || "").trim();
const agentName = String(process.env.PRINT_AGENT_NAME || "").trim() || os.hostname() || "print-agent";
const pollIntervalMs = Math.max(Number(process.env.PRINT_AGENT_POLL_INTERVAL_MS || 2000) || 2000, 500);
const defaultPrinterName = String(process.env.PRINT_AGENT_DEFAULT_PRINTER_NAME || "").trim();
const printerNames = String(process.env.PRINT_AGENT_PRINTERS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const windowsPrintTimeoutSec = Math.max(
  Number(process.env.PRINT_AGENT_WINDOWS_PRINT_TIMEOUT_SEC || 20) || 20,
  5,
);

if (!baseUrl) {
  console.error("[print-agent] Missing WMS_BASE_URL");
  process.exit(1);
}
if (!apiKey) {
  console.error("[print-agent] Missing PRINT_AGENT_API_KEY");
  process.exit(1);
}

function log(message) {
  console.log(`[print-agent] ${new Date().toISOString()} ${message}`);
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
      printerName: printerName || undefined,
      systemJobId: systemJobId || undefined,
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
  const printerName = String(job.printerName || "").trim() || defaultPrinterName || "";
  const tempDir = path.join(os.tmpdir(), "wms-print-agent", randomUUID());
  const fileName = String(job.fileName || "yamato-label.pdf").replace(/[^A-Za-z0-9._-]+/g, "_");
  const tempFilePath = path.join(tempDir, fileName || "yamato-label.pdf");
  await mkdir(tempDir, { recursive: true });
  await writeFile(tempFilePath, pdfBuffer);

  try {
    if (process.platform === "win32") {
      const scriptPath = path.join(__dirname, "print-pdf-windows.ps1");
      const args = [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-FilePath",
        tempFilePath,
        "-TimeoutSeconds",
        String(windowsPrintTimeoutSec),
      ];
      if (printerName) {
        args.push("-PrinterName", printerName);
      }
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
          `Windows PDF print failed: ${message}. Confirm the PDF default app supports shell Print/PrintTo and the printer name matches Windows settings.`,
        );
      }
    }

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

  try {
    const pdfBuffer = await downloadJobFile(job.id, job.claimToken);
    const printResult = await sendPdfToPrinter(job, pdfBuffer);
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
    log(`Job #${job.id} failed: ${message}`);
    return true;
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  log(`Started with base URL ${baseUrl}`);
  log(`Print platform: ${process.platform === "win32" ? "windows-shell" : "lp"}`);
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
