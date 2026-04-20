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

- Set the exact local printer queue name for products that must go to a dedicated printer.
- Leave it empty if the product should use the print-agent machine's default printer.
- When scan printing queues a job, WMS writes this field into `print_jobs.printer_name`, so products can be routed to different local printers automatically.

You can configure it from the master product detail page inside WMS.

## Warehouse Computer Setup

On the real print computer:

1. Install the required printer(s) in the operating system.
2. Confirm the machine itself can print normally to both printers.
3. Pull the latest repository code.
4. Configure environment variables.
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
cd C:\path\to\wms-main
$env:WMS_BASE_URL = "https://your-wms-domain"
$env:PRINT_AGENT_API_KEY = "replace-with-a-long-random-string"
$env:PRINT_AGENT_NAME = "warehouse-pc-01"
$env:PRINT_AGENT_DEFAULT_PRINTER_NAME = "Yamato-Default"
$env:PRINT_AGENT_PRINTERS = "Yamato-A,Yamato-B,Yamato-Default"
npm run -w print-agent start
```

Windows notes:

- The printer names must exactly match the names shown in Windows "Printers & scanners".
- The agent uses `powershell.exe` with the shell `Print` / `PrintTo` verbs to print PDF files.
- The default PDF application on the warehouse PC must support shell printing. If Windows can open the PDF but cannot print from the agent, change the default PDF app to one that supports silent print verbs and test again.

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
2. Set one or two products with a known printer name.
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
- If a product should always go to a specific printer:
  - Confirm `yamatoPrinterName` is filled on the master product.
- If no product printer is set:
  - The agent falls back to `PRINT_AGENT_DEFAULT_PRINTER_NAME`, then to the OS default printer.
