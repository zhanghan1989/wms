# UTF-8 文本命令约定

仓库内所有文本文件统一按 UTF-8 处理。

## PowerShell

在当前会话先执行：

```powershell
. .\scripts\use-utf8.ps1
```

执行后会统一设置：

- `Get-Content`
- `Select-String`
- `Set-Content`
- `Add-Content`
- `Out-File`
- 控制台输入输出编码

以上都改为显式 UTF-8，避免中文、日文在 Windows 默认编码下出现假乱码。

## 推荐写法

读取文本：

```powershell
Get-Content -Path README.md
Get-Content -Encoding utf8 -Path apps\api\public\app.js
```

搜索文本：

```powershell
Get-ChildItem -Recurse | Select-String -Pattern '库存'
Select-String -Path apps\api\src\**\*.ts -Pattern 'FBA' -Encoding utf8
```

写出文本：

```powershell
'hello' | Out-File -Path tmp.txt
Set-Content -Path tmp.txt -Value 'hello'
```

## Node 脚本

Node 侧读取文本时必须显式使用 UTF-8 或先做 UTF-8 校验。

当前仓库编码检查脚本 [scripts/check-text-encoding.mjs](/C:/zhanghan/01-IT/03-soft/002-WMS/scripts/check-text-encoding.mjs) 已统一为显式 UTF-8 的 Git 输出和文本解码。
