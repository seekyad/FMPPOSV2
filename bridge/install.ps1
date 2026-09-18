# FMP POS print bridge installer for the store PC (Windows 10/11, PowerShell 5.1 or newer).
#
#   Open PowerShell on the store PC and paste:
#     irm https://www.fmppos.com/bridge/install.ps1 | iex
#
# It installs Node.js if needed, downloads the bridge, finds the receipt printer on the
# network, pairs the bridge with the store (you paste a one-time code from Settings ->
# Registers & bridges -> "Pair a print bridge"), makes the Niimbot the default label
# printer, registers the bridge to start at logon, and starts it.
#
# Optional environment overrides, set before running:
#   FMP_SERVER        POS address (default: the site this script came from)
#   FMP_INSTALL_DIR   folder for the bridge (default: %LOCALAPPDATA%\FMPPOS\bridge)
#   FMP_RECEIPT_IP    Rongta IP address for a network printer (skips detection and prompts)
#   FMP_RECEIPT_PRINTER  Windows printer name for a USB receipt printer (skips detection and prompts)
#   FMP_PAIRING_CODE  bridge pairing code (skips the prompt)
#   FMP_SKIP_PRINTER  1 = leave the Windows default printer alone
#   FMP_SKIP_TASK     1 = do not register or start the logon task

$ErrorActionPreference = 'Stop'
$Server = if ($env:FMP_SERVER) { $env:FMP_SERVER.TrimEnd('/') } else { '__SERVER_URL__' }
$Dir = if ($env:FMP_INSTALL_DIR) { $env:FMP_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'FMPPOS\bridge' }
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Step($msg) { Write-Host ''; Write-Host "== $msg" -ForegroundColor Cyan }
function WriteText($path, $text) { [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom) }

Step "FMP POS print bridge installer"
Write-Host "POS server:     $Server"
Write-Host "Install folder: $Dir"

# ---------------------------------------------------------------- 1. Node.js
Step 'Checking Node.js'
function NodeOk {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $false }
  $v = (& $cmd.Source -v) -replace '^v', ''
  return ([int]($v.Split('.')[0]) -ge 20)
}
if (NodeOk) {
  Write-Host ("Node " + (& node -v) + " found")
} else {
  Write-Host 'Installing Node.js LTS with winget (a few minutes)...'
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'Node.js 20 or newer is not installed and winget is not available. Install Node.js LTS from https://nodejs.org, open a new PowerShell window, and run this again.'
  }
  & winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements --silent | Out-Null
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (NodeOk)) { throw 'Node.js was installed but this window cannot see it yet. Open a new PowerShell window and run the installer again.' }
  Write-Host ("Node " + (& node -v) + " installed")
}
$NodeExe = (Get-Command node).Source
$NpmCmd = Join-Path (Split-Path $NodeExe) 'npm.cmd'

# ---------------------------------------------------------------- 2. Bridge files
Step 'Downloading the bridge'
New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'src') | Out-Null
foreach ($f in @('package.json', 'src/index.js', 'src/pair.js', 'src/rawprint.ps1')) {
  Invoke-WebRequest -UseBasicParsing -Uri "$Server/bridge/files/$f" -OutFile (Join-Path $Dir $f)
}
Push-Location $Dir
try {
  & $NpmCmd install --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed; check the internet connection and run again.' }
} finally { Pop-Location }
Write-Host 'Bridge files ready'

# ---------------------------------------------------------------- 3. Receipt printer
Step 'Receipt printer (Rongta)'
$ReceiptIp = $env:FMP_RECEIPT_IP
$ReceiptPrinter = $env:FMP_RECEIPT_PRINTER
if (-not $ReceiptIp -and -not $ReceiptPrinter) {
  # a receipt printer plugged into this PC by USB shows up as a Windows printer; that beats any network scan
  $localReceipt = @(Get-Printer -ErrorAction SilentlyContinue | Where-Object { ($_.Name + ' ' + $_.DriverName) -match 'Rongta|RP80|RP58|RP3|POS-?80|POS-?58|XP-?80|XP-?58|Thermal|Receipt|TM-T|TSP' })
  if ($localReceipt.Count -eq 1) {
    $ReceiptPrinter = $localReceipt[0].Name
    Write-Host ("Found a receipt printer on this PC: " + $ReceiptPrinter + " (" + $localReceipt[0].PortName + ")")
  } elseif ($localReceipt.Count -gt 1) {
    for ($i = 0; $i -lt $localReceipt.Count; $i++) { Write-Host ("  [{0}] {1}  ({2})" -f ($i + 1), $localReceipt[$i].Name, $localReceipt[$i].PortName) }
    $pick = Read-Host 'Which one is the receipt printer? Enter its number'
    $ReceiptPrinter = $localReceipt[[int]$pick - 1].Name
  }
}
if (-not $ReceiptIp -and -not $ReceiptPrinter) {
  Write-Host 'No receipt printer is installed on this PC. Looking for a network printer on port 9100 (about 10 seconds)...'
  $scan = @'
const net=require('net'),os=require('os');
const bases=[...new Set(Object.values(os.networkInterfaces()).flat().filter(n=>n&&n.family==='IPv4'&&!n.internal).map(n=>n.address.split('.').slice(0,3).join('.')))];
const dns=require('dns').promises;
const probe=h=>new Promise(r=>{const s=net.createConnection({host:h,port:9100});const done=ok=>{s.destroy();r(ok?h:null)};s.setTimeout(700,()=>done(false));s.on('connect',()=>done(true));s.on('error',()=>done(false));});
(async()=>{const hits=[];for(const b of bases){const batch=[];for(let i=1;i<255;i++)batch.push(probe(b+'.'+i));hits.push(...(await Promise.all(batch)).filter(Boolean));}
for(const h of hits){const name=(await dns.reverse(h).catch(()=>[]))[0]||'';console.log(h+'|'+name);}})();
'@
  $scanFile = Join-Path $Dir 'scan9100.js'
  WriteText $scanFile $scan
  $lines = @((& $NodeExe $scanFile) | Where-Object { $_ -and $_.Trim() })
  Remove-Item $scanFile -Force -ErrorAction SilentlyContinue
  # office printers (Canon, HP, Brother...) also answer on 9100; name them so they are not mistaken for the Rongta
  $hits = @(); $office = @()
  foreach ($l in $lines) {
    $parts = $l.Trim().Split('|'); $ip = $parts[0]; $name = if ($parts.Count -gt 1) { $parts[1] } else { '' }
    $desc = if ($name) { "$ip ($name)" } else { $ip }
    if ($name -match 'canon|hp|brother|epson|lexmark|kyocera|xerox|ricoh|samsung|dell') { $office += $desc } else { $hits += $ip; Write-Host "  candidate: $desc" }
  }
  foreach ($o in $office) { Write-Host "  skipped office printer: $o" }
  $default = ''
  if ($hits.Count -eq 1) { $default = $hits[0]; Write-Host "Found a printer at $default" }
  elseif ($hits.Count -gt 1) { Write-Host ("Found several devices on port 9100: " + ($hits -join ', ')) }
  else { Write-Host 'No receipt printer answered on port 9100. If the Rongta is on USB, plug it into this PC and let Windows install it, then run this again.' }
  $prompt = if ($default) { "Receipt printer IP [$default]" } else { 'Receipt printer IP (leave blank to set up later)' }
  $typed = Read-Host $prompt
  $ReceiptIp = if ($typed) { $typed.Trim() } else { $default }
}
if ($ReceiptPrinter) { Write-Host "Receipts will print on the Windows printer '$ReceiptPrinter'" }
elseif ($ReceiptIp) { Write-Host "Receipts will print to $ReceiptIp on port 9100" }
else { Write-Host 'Receipt printer skipped; add it to config.json later.' -ForegroundColor Yellow }

# ---------------------------------------------------------------- 4. Config
Step 'Writing config.json'
$configPath = Join-Path $Dir 'config.json'
$config = [ordered]@{
  serverUrl = $Server
  storeId = 0
  name = "$env:COMPUTERNAME print bridge"
  labelPrinter = [ordered]@{ settleMs = 6000 }
  deviceToken = ''
}
if ($ReceiptPrinter) { $config.receiptPrinter = [ordered]@{ mode = 'windows'; printerName = $ReceiptPrinter } }
elseif ($ReceiptIp) { $config.receiptPrinter = [ordered]@{ mode = 'tcp'; host = $ReceiptIp; port = 9100 } }
if (Test-Path $configPath) {
  try {
    $old = Get-Content $configPath -Raw | ConvertFrom-Json
    if ($old.deviceToken) { $config.deviceToken = $old.deviceToken; $config.storeId = $old.storeId; Write-Host 'Keeping the existing pairing' }
  } catch {}
}
WriteText $configPath (($config | ConvertTo-Json -Depth 4) + "`n")

# ---------------------------------------------------------------- 5. Pairing
Step 'Pairing with the store'
if ($config.deviceToken) {
  Write-Host 'Already paired; skipping. Delete config.json to pair again.'
} else {
  $code = $env:FMP_PAIRING_CODE
  if (-not $code) {
    Write-Host 'On any signed-in register: Settings -> Registers & bridges -> "Pair a print bridge". The code lasts 15 minutes.'
    $code = Read-Host 'Paste the bridge pairing code'
  }
  $env:FMP_PAIRING_CODE = $code.Trim()
  Push-Location $Dir
  try {
    & $NodeExe src/pair.js
    if ($LASTEXITCODE -ne 0) { throw 'Pairing failed. Get a fresh bridge code and run the installer again.' }
  } finally { Pop-Location; Remove-Item Env:FMP_PAIRING_CODE -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------- 6. Label printer
Step 'Label printer (Niimbot)'
if ($env:FMP_SKIP_PRINTER -eq '1') {
  Write-Host 'Skipped (FMP_SKIP_PRINTER=1)'
} else {
  $niimbots = @(Get-Printer -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*NIIMBOT*' -or $_.DriverName -like '*NIIMBOT*' })
  $label = $null
  if ($niimbots.Count -eq 1) { $label = $niimbots[0] }
  elseif ($niimbots.Count -gt 1) {
    $k3 = $niimbots | Where-Object { $_.Name -like '*K3*' } | Select-Object -First 1
    if ($k3) { $label = $k3 } else {
      for ($i = 0; $i -lt $niimbots.Count; $i++) { Write-Host ("  [{0}] {1}  ({2})" -f ($i + 1), $niimbots[$i].Name, $niimbots[$i].PortName) }
      $pick = Read-Host 'Which printer prints labels? Enter its number'
      $label = $niimbots[[int]$pick - 1]
    }
  }
  if ($label) {
    New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows' -Name LegacyDefaultPrinterMode -Value 1 -PropertyType DWord -Force | Out-Null
    $null = Get-CimInstance Win32_Printer -Filter ("Name='" + $label.Name.Replace("'", "''") + "'") | Invoke-CimMethod -MethodName SetDefaultPrinter
    Write-Host ("Labels will print on " + $label.Name + " (now the default printer; Windows will no longer change it on its own)")
  } else {
    Write-Host 'No Niimbot printer is installed on this PC. Plug it in by USB, let Windows install it, then set it as the default printer.' -ForegroundColor Yellow
  }
}

# ---------------------------------------------------------------- 7. Start at logon
Step 'Starting the bridge'
$vbs = Join-Path $Dir 'start-hidden.vbs'
WriteText $vbs ("Set sh = CreateObject(""WScript.Shell"")`r`nsh.CurrentDirectory = """ + $Dir + """`r`nsh.Run ""cmd /c """"" + $NodeExe + """"" src\index.js >> bridge.log 2>&1"", 0, False`r`n")
# stop any bridge already running from this folder
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'node*' -and $_.CommandLine -like '*src\index.js*' -and $_.CommandLine -notlike '*FMPPOSV2*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if ($env:FMP_SKIP_TASK -eq '1') {
  Write-Host "Skipped the logon task (FMP_SKIP_TASK=1). Start it by hand with:  wscript.exe `"$vbs`""
} else {
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"') -WorkingDirectory $Dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName 'FMP POS print bridge' -Action $action -Trigger $trigger -Settings $settings -Description 'Prints receipts and labels for FMP POS. Installed by install.ps1.' -Force | Out-Null
  Start-ScheduledTask -TaskName 'FMP POS print bridge'
  Start-Sleep -Seconds 7
  $log = Join-Path $Dir 'bridge.log'
  $tail = if (Test-Path $log) { Get-Content $log -Tail 5 } else { @() }
  if ($tail -match 'connected to') {
    Write-Host ''
    Write-Host 'DONE. The bridge is running and connected. Settings -> Print center on any register should now show it online.' -ForegroundColor Green
    Write-Host 'It starts again automatically whenever this user signs in to this PC.'
  } else {
    Write-Host ''
    Write-Host 'The bridge was started but has not reported a connection yet. Last log lines:' -ForegroundColor Yellow
    $tail | ForEach-Object { Write-Host "  $_" }
    Write-Host "Log file: $log"
  }
}
