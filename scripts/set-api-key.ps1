# Carga ANTHROPIC_API_KEY como secreto del Worker "leyclara" en Cloudflare.
# La key se pide oculta, no queda en el historial de PowerShell ni en archivos.
#
#   powershell -ExecutionPolicy Bypass -File scripts\set-api-key.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\set-api-key.ps1 -TambienLocal   # además actualiza .dev.vars
#
# Requiere que el Worker ya esté desplegado (npm run deploy) y `npx wrangler login`.
param([switch]$TambienLocal)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
# En algunas redes IPv6 no llega a api.cloudflare.com y wrangler se cuelga.
$env:NODE_OPTIONS = "$env:NODE_OPTIONS --dns-result-order=ipv4first"

$seguro = Read-Host -AsSecureString "Pega tu ANTHROPIC_API_KEY (no se mostrará)"
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro)
try {
    $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim()
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if (-not $key.StartsWith("sk-ant-")) {
    Write-Host "Eso no parece una API key de Anthropic (debería empezar con sk-ant-). No se cargó nada." -ForegroundColor Red
    exit 1
}

Write-Host "Cargando el secreto en Cloudflare..."
$key | npx wrangler secret put ANTHROPIC_API_KEY --env=""
if ($LASTEXITCODE -ne 0) {
    Write-Host "Wrangler falló. ¿Ya hiciste el deploy y el login?" -ForegroundColor Red
    exit 1
}

if ($TambienLocal) {
    $ruta = ".dev.vars"
    $lineas = @()
    if (Test-Path $ruta) { $lineas = @(Get-Content $ruta | Where-Object { $_ -notmatch '^ANTHROPIC_API_KEY=' }) }
    $lineas += "ANTHROPIC_API_KEY=$key"
    [IO.File]::WriteAllLines((Join-Path (Get-Location) $ruta), [string[]]$lineas)
    Write-Host ".dev.vars actualizado (está en .gitignore)."
}

Remove-Variable key, seguro -ErrorAction SilentlyContinue
Write-Host "Listo. Prueba: npx wrangler secret list" -ForegroundColor Green
