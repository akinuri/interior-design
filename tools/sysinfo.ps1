<#
  System info relevant to the app's rendering performance (Windows).
  Pair it with the in-app report (click the FPS readout) from the same machine.

  Run:  powershell -ExecutionPolicy Bypass -File tools\sysinfo.ps1
  Writes sysinfo_<date>.json in the current folder and prints a summary.
  No user name or computer name is collected.
#>

$ErrorActionPreference = 'SilentlyContinue'

function Get-FileVersion($path) {
  if (Test-Path $path) { (Get-Item $path).VersionInfo.ProductVersion } else { $null }
}

function Get-BrowserSettings($localStatePath) {
  # Chrome / Edge keep hardware acceleration + energy saver state in "Local State".
  if (-not (Test-Path $localStatePath)) { return $null }
  try {
    $s = Get-Content $localStatePath -Raw | ConvertFrom-Json
    [ordered]@{
      hardwareAccelerationEnabled = $s.hardware_acceleration_mode.enabled   # null = default (on)
      energySaverState            = $s.performance_tuning.battery_saver_mode.state  # 0 off, 1 on below 20% battery, 2 on when unplugged (Chrome)
      highEfficiencyMode          = $s.performance_tuning.high_efficiency_mode.state
      labExperiments              = $s.browser.enabled_labs_experiments
    }
  } catch { $null }
}

$os   = Get-CimInstance Win32_OperatingSystem
$cpu  = Get-CimInstance Win32_Processor
$cs   = Get-CimInstance Win32_ComputerSystem
$gpus = Get-CimInstance Win32_VideoController
$bat  = Get-CimInstance Win32_Battery

# Display: resolution / refresh per adapter, scaling from the applied DPI.
$appliedDpi = (Get-ItemProperty 'HKCU:\Control Panel\Desktop\WindowMetrics').AppliedDPI
$monitors = Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID | ForEach-Object {
  [ordered]@{
    manufacturer = (-join ($_.ManufacturerName | Where-Object { $_ } | ForEach-Object { [char]$_ }))
    model        = (-join ($_.UserFriendlyName | Where-Object { $_ } | ForEach-Object { [char]$_ }))
  }
}
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [ordered]@{ primary = $_.Primary; bounds = "$($_.Bounds.Width)x$($_.Bounds.Height)"; bitsPerPixel = $_.BitsPerPixel }
}

# Windows per-app GPU preference (Settings > System > Display > Graphics).
# "GpuPreference=1" = power saving (integrated), "2" = high performance (dedicated).
$gpuPrefs = @()
$prefKey = 'HKCU:\Software\Microsoft\DirectX\UserGpuPreferences'
if (Test-Path $prefKey) {
  $props = Get-ItemProperty $prefKey
  foreach ($p in $props.PSObject.Properties) {
    if ($p.Name -match '\.exe$') { $gpuPrefs += [ordered]@{ app = (Split-Path $p.Name -Leaf); setting = $p.Value } }
  }
}

$hags = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers').HwSchMode  # 2 = on, 1 = off
$powerScheme = (powercfg /getactivescheme) -replace '^.*:\s*', ''

$report = [ordered]@{
  tool      = 'interior-design sysinfo'
  version   = 1
  takenAt   = (Get-Date).ToString('o')
  os        = [ordered]@{ name = $os.Caption; version = $os.Version; build = $os.BuildNumber; architecture = $os.OSArchitecture }
  cpu       = @($cpu | ForEach-Object { [ordered]@{ name = $_.Name.Trim(); cores = $_.NumberOfCores; threads = $_.NumberOfLogicalProcessors; maxClockMHz = $_.MaxClockSpeed; currentClockMHz = $_.CurrentClockSpeed } })
  memoryGB  = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
  model     = [ordered]@{ manufacturer = $cs.Manufacturer; model = $cs.Model }
  gpus      = @($gpus | ForEach-Object {
    [ordered]@{
      name            = $_.Name
      driverVersion   = $_.DriverVersion
      driverDate      = if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') } else { $null }
      videoMemoryMB   = if ($_.AdapterRAM) { [math]::Round($_.AdapterRAM / 1MB) } else { $null }  # caps at 4096 in WMI
      resolution      = if ($_.CurrentHorizontalResolution) { "$($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution)" } else { $null }
      refreshRateHz   = $_.CurrentRefreshRate
      status          = $_.Status
    }
  })
  display   = [ordered]@{
    scalingPercent = if ($appliedDpi) { [math]::Round($appliedDpi / 96 * 100) } else { $null }
    screens        = @($screens)
    monitors       = @($monitors)
  }
  power     = [ordered]@{
    activePlan       = $powerScheme
    battery          = if ($bat) { [ordered]@{ chargePercent = $bat.EstimatedChargeRemaining; status = $bat.BatteryStatus } } else { $null }  # status 2 = on AC
  }
  graphics  = [ordered]@{
    hardwareAcceleratedGpuScheduling = switch ($hags) { 2 { 'on' } 1 { 'off' } default { 'default' } }
    perAppGpuPreferences             = @($gpuPrefs)
  }
  browsers  = [ordered]@{
    chrome  = [ordered]@{
      version  = @(
        (Get-FileVersion "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"),
        (Get-FileVersion "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"),
        (Get-FileVersion "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
      ) | Where-Object { $_ } | Select-Object -First 1
      settings = Get-BrowserSettings "$env:LOCALAPPDATA\Google\Chrome\User Data\Local State"
    }
    edge    = [ordered]@{
      version  = Get-FileVersion "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
      settings = Get-BrowserSettings "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Local State"
    }
    firefox = [ordered]@{ version = Get-FileVersion "$env:ProgramFiles\Mozilla Firefox\firefox.exe" }
  }
}

$file = "sysinfo_$((Get-Date).ToString('yyyy-MM-dd_HH-mm')).json"
$report | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 $file

Write-Host ''
Write-Host "OS:      $($report.os.name) (build $($report.os.build))"
Write-Host "CPU:     $($report.cpu[0].name) - $($report.cpu[0].cores) cores / $($report.cpu[0].threads) threads"
Write-Host "Memory:  $($report.memoryGB) GB"
foreach ($g in $report.gpus) { Write-Host "GPU:     $($g.name) - driver $($g.driverVersion) ($($g.driverDate)) - $($g.resolution) @ $($g.refreshRateHz) Hz" }
Write-Host "Scaling: $($report.display.scalingPercent)%"
Write-Host "Power:   $($report.power.activePlan)$(if ($report.power.battery) { " - battery $($report.power.battery.chargePercent)%" })"
foreach ($p in $report.graphics.perAppGpuPreferences) { Write-Host "GPU pref: $($p.app) -> $($p.setting)" }
Write-Host "Chrome:  $($report.browsers.chrome.version) - hw accel: $($report.browsers.chrome.settings.hardwareAccelerationEnabled) - energy saver: $($report.browsers.chrome.settings.energySaverState)"
Write-Host "Edge:    $($report.browsers.edge.version) - hw accel: $($report.browsers.edge.settings.hardwareAccelerationEnabled) - energy saver: $($report.browsers.edge.settings.energySaverState)"
Write-Host ''
Write-Host "Saved: $file"
