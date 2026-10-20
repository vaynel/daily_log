$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'Store.cs') -ReferencedAssemblies @('System.dll', 'System.Security.dll') -ErrorAction Stop
    [DailyLogStore]::Run()
    exit [Environment]::ExitCode
} catch {
    [Console]::WriteLine('ERROR WINDOWS_HELPER_UNAVAILABLE')
    exit 1
}
