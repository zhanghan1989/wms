# WMS Print Agent Setup

## Overview

This mode is used when the real label printer is connected to a separate warehouse computer instead of the WMS server.

Flow:

1. WMS creates a Yamato print job after scanning a product ID.
2. The local `print-agent` running on the warehouse computer polls the WMS server.
3. The agent downloads the single-page PDF label.
4. The agent sends the PDF to the configured local printer using the local OS print command.
5. After the agent reports success, WMS marks that page as printed.

## Server Configuration

Configure the API service with:

```env
YAMATO_PRINT_MODE=agent
PRINT_AGENT_API_KEY=replace-with-a-long-random-string
```

Notes:

- `YAMATO_PRINT_MODE=agent` switches the overseas Yamato scan flow from browser printing to queued print-agent mode.
- `PRINT_AGENT_API_KEY` must be the same on the server and on every print-agent client.

## Product Printer Configuration

Each master product now supports a `yamatoPrinterName` field.

Recommended usage:

- Leave it empty for products that should print to the Windows printer named `ヤマト`.
- Set it to `A` for products that should print to the Windows printer named `ネコポス`.
- If another value is used later, WMS will treat that value as the exact printer queue name.
- When scan printing queues a job, WMS writes the resolved real printer name into `print_jobs.printer_name`, so products can be routed to different local printers automatically.

You can configure it from the master product detail page inside WMS.

## Warehouse Computer Setup

Build a standalone Windows package on the development/server machine:

```bash
npm run package:print-agent:exe
```

This creates:

```text
dist/print-agent-windows
```

Copy that folder to the real Windows print computer. The Windows computer does not need the whole WMS repository, and if `wms-print-agent.exe` exists it does not need Node.js either.

On the real print computer:

1. Install the required printer(s) in the operating system.
2. Confirm the machine itself can print normally to both printers.
3. Copy `dist/print-agent-windows` to a stable folder, for example `C:\wms-print-agent`.
4. Copy `.env.example` to `.env` and edit the server URL / API key.
5. Start the local print-agent.

### Linux / macOS Example

```bash
cd /path/to/wms-main
export WMS_BASE_URL="https://your-wms-domain"
export PRINT_AGENT_API_KEY="replace-with-a-long-random-string"
export PRINT_AGENT_NAME="warehouse-pc-01"
export PRINT_AGENT_DEFAULT_PRINTER_NAME="Yamato-Default"
export PRINT_AGENT_PRINTERS="Yamato-A,Yamato-B,Yamato-Default"
npm run -w print-agent start
```

### Windows PowerShell Example

```powershell
cd C:\wms-print-agent
Copy-Item .env.example .env
notepad .env

.\list-printers.ps1
.\start-agent.ps1
```

Windows notes:

- The printer names must exactly match the names shown in Windows "Printers & scanners".
- Run `.\list-printers.ps1` on the Windows warehouse PC to print the exact names the agent can see.
- Before printing to a named Windows printer, the agent verifies that the name exists locally. If it does not match, the job fails with the available printer list instead of silently using the wrong printer.
- The agent uses `powershell.exe` with the shell `Print` / `PrintTo` verbs to print PDF files.
- The default PDF application on the warehouse PC must support shell printing. If Windows can open the PDF but cannot print from the agent, change the default PDF app to one that supports silent print verbs and test again.

### Windows Auto Start

Recommended mode:

```powershell
cd C:\wms-print-agent
.\install-startup-task.ps1
Start-ScheduledTask -TaskName "WMS Print Agent"
```

This installs a Windows Task Scheduler entry that starts the agent after the Windows user logs in. This is usually more reliable than a true Windows service for PDF shell printing.

Optional NSSM service mode:

```powershell
cd C:\wms-print-agent
.\install-service-nssm.ps1
```

Only use NSSM mode if the local PDF app can print from a Windows service session. If `PrintTo` fails as a service, uninstall it and use `install-startup-task.ps1`.

## Print-Agent Environment Variables

- `WMS_BASE_URL`
  - Required.
  - Example: `https://wms.example.com`
- `PRINT_AGENT_API_KEY`
  - Required.
  - Must match the API server configuration.
- `PRINT_AGENT_NAME`
  - Optional.
  - Used for job claim records and troubleshooting.
- `PRINT_AGENT_POLL_INTERVAL_MS`
  - Optional.
  - Default: `2000`
- `PRINT_AGENT_DEFAULT_PRINTER_NAME`
  - Optional.
  - Used when the product itself does not define a printer.
- `PRINT_AGENT_PRINTERS`
  - Optional.
  - Comma-separated printer names.
  - When set, the agent only claims jobs for these printers or jobs without a specific printer.
- `PRINT_AGENT_WINDOWS_PRINT_TIMEOUT_SEC`
  - Optional.
  - Windows only.
  - Default: `20`
  - How long to wait for the local PDF print process before the agent closes it.

## Recommended Rollout

1. Apply the latest Prisma migration on the API database.
2. Confirm products with an empty `yamatoPrinterName` print to `ヤマト`, and products with `yamatoPrinterName=A` print to `ネコポス`.
3. Start the print-agent on the warehouse computer.
4. Upload Yamato PDF in WMS.
5. Scan a product ID and confirm the job is printed by the expected printer.

## Troubleshooting

- If scanning succeeds but nothing prints:
  - Check the print-agent terminal logs first.
- If the agent says there is no printer:
  - On Windows, verify the printer name exactly matches the name shown in "Printers & scanners".
  - On Linux/macOS, verify the printer name exactly matches the local `lpstat -a` queue name.
- If Windows reports `PrintTo` or `Print` failure:
  - Confirm the default PDF application supports shell printing.
- If a product should print to `ネコポス`:
  - Confirm `yamatoPrinterName` is `A` on the master product.
- If a product should print to `ヤマト`:
  - Leave `yamatoPrinterName` empty on the master product.
