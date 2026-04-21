# WMS Print Agent for Windows

This folder is a standalone Windows print-agent package.

## 1. Prepare

If this folder contains `wms-print-agent.exe`, Node.js is not required on the Windows computer.

If this folder does not contain `wms-print-agent.exe`, install Node.js LTS first.

Make sure the Windows printer names include:

- `ヤマト`
- `ネコポス`

## 2. Configure

Copy `.env.example` to `.env`, then edit:

```env
WMS_BASE_URL=https://your-wms-domain
PRINT_AGENT_API_KEY=replace-with-the-same-key-as-server
PRINT_AGENT_NAME=warehouse-win-01
PRINT_AGENT_PRINTERS=ヤマト,ネコポス
PRINT_AGENT_WINDOWS_PRINT_TIMEOUT_SEC=20
```

The server must use the same `PRINT_AGENT_API_KEY` and must run with:

```env
YAMATO_PRINT_MODE=agent
```

## 3. Check Printers

```powershell
.\list-printers.ps1
```

Confirm the output includes `ヤマト` and `ネコポス`.

## 4. Start Manually

```powershell
.\start-agent.ps1
```

## 5. Start Automatically After Login

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
