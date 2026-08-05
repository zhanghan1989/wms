# WMS Print Agent for Windows

This folder is a standalone Windows print-agent package.

## 1. Prepare

If this folder contains `wms-print-agent.exe`, Node.js is not required on the Windows computer.

If this folder does not contain `wms-print-agent.exe`, install Node.js LTS first.

Make sure the Windows printer names include:

- `yamato`
- `nekoposu`

## 2. Configure

Copy `.env.example` to `.env`, then edit:

```env
WMS_BASE_URL=https://wms.fulangke.cn
PRINT_AGENT_API_KEY=replace-with-the-same-key-as-server
PRINT_AGENT_NAME=warehouse-win-01
PRINT_AGENT_PRINTERS=yamato,nekoposu
PRINT_AGENT_WINDOWS_PRINT_TIMEOUT_SEC=20
# Recommended for stable silent PDF printing on Windows:
# PRINT_AGENT_WINDOWS_PDF_TOOL_PATH=SumatraPDF.exe
```

Do not keep the legacy `http://8.134.176.116:3000` address in `.env`. After changing
`WMS_BASE_URL`, restart the print agent or its scheduled task.

The server must use the same `PRINT_AGENT_API_KEY` and must run with:

```env
YAMATO_PRINT_MODE=agent
```

## 3. Check Printers

```powershell
.\list-printers.ps1
```

Confirm the output includes `yamato` and `nekoposu`.

## 4. Recommended PDF Printer Tool

Windows Shell `PrintTo` depends on the default PDF application. Some default PDF apps cannot print silently to a specified printer.

For stable label printing, put `SumatraPDF.exe` in the same folder as `wms-print-agent.exe`.

The agent checks these locations automatically:

- `PRINT_AGENT_WINDOWS_PDF_TOOL_PATH` from `.env`
- `SumatraPDF.exe` next to `wms-print-agent.exe`
- `sumatrapdf.exe` next to `wms-print-agent.exe`
- `C:\Program Files\SumatraPDF\SumatraPDF.exe`
- `C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe`

If no SumatraPDF executable is found, the agent falls back to Windows Shell `PrintTo`.

## 5. Start Manually

```powershell
.\start-agent.ps1
```

## 6. Start Automatically After Login

Run PowerShell as Administrator:

```powershell
.\install-startup-task.ps1
Start-ScheduledTask -TaskName "WMS Print Agent"
```

This uses Windows Task Scheduler and starts the agent after the Windows user logs in. This is the recommended mode for PDF `PrintTo`, because many PDF applications need a user session.

To uninstall:

```powershell
.\uninstall-startup-task.ps1
```

## Optional NSSM Service

If you already use NSSM and want a Windows service:

```powershell
.\install-service-nssm.ps1
```

If PDF printing fails when running as a service, use `install-startup-task.ps1` instead.
