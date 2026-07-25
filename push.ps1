#Requires -Version 5.1

<#
.SYNOPSIS
    Commit en push dit repository naar GitHub.
.DESCRIPTION
    Ruimt achtergebleven git lock-bestanden op (ontstaan door de Claude mount),
    commit alle wijzigingen, zet de branch en remote goed, en pusht.

    Authenticatie loopt volledig via de Windows Git Credential Manager, die
    standaard met Git for Windows wordt meegeleverd. Bij de eerste push opent
    eenmalig een browservenster om in te loggen bij GitHub; daarna wordt de
    login onthouden. Er staan dus nergens wachtwoorden of tokens op schijf.
.PARAMETER Message
    Commit-bericht. Standaard: "Update <datum tijd>".
.PARAMETER RemoteUrl
    GitHub remote. Standaard het microsoft-admin-mcp repo van xchello.
.PARAMETER Branch
    Doelbranch. Standaard main.
.EXAMPLE
    PS> .\push.ps1
.EXAMPLE
    PS> .\push.ps1 -Message "v0.4.0: nieuwe rapportagefuncties"
.NOTES
    Auteur: Xander Oortgiesen (gegenereerd door Claude)
    Versie: 2.0
#>

[CmdletBinding()]
param(
    [string]$Message   = "Update $(Get-Date -Format 'yyyy-MM-dd HH:mm')",
    [string]$RemoteUrl = 'https://github.com/xchello/microsoft-admin-mcp.git',
    [string]$Branch    = 'main'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }

try {
    Set-Location -Path $PSScriptRoot

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "git is niet gevonden. Installeer Git for Windows: https://git-scm.com/download/win"
    }

    # --- Achtergebleven lock-bestanden opruimen ---
    Write-Step "Lock-bestanden opruimen"
    Get-ChildItem -Path (Join-Path $PSScriptRoot '.git') -Recurse -Filter '*.lock' -File -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue

    # --- Identiteit (alleen zetten als die nog ontbreekt) ---
    if (-not (git config user.name))  { git config user.name  'Xander Oortgiesen' }
    if (-not (git config user.email)) { git config user.email 'xanderoortgiesen@gmail.com' }

    # --- Committen ---
    Write-Step "Wijzigingen committen"
    git rm -r --cached _to_delete 2>$null | Out-Null   # nooit tijdelijke bestanden meesturen
    git add -A
    if (git status --porcelain) {
        git commit -m $Message | Out-Host
    } else {
        Write-Host "Geen nieuwe wijzigingen om te committen."
    }

    # --- Branch en remote ---
    git branch -M $Branch
    if ((git remote) -contains 'origin') {
        git remote set-url origin $RemoteUrl
    } else {
        git remote add origin $RemoteUrl
    }

    # --- Pushen (Git Credential Manager regelt de login) ---
    Write-Step "Pushen naar $RemoteUrl ($Branch)"
    git push -u origin $Branch
    if ($LASTEXITCODE -ne 0) {
        throw ("git push is mislukt (exit code $LASTEXITCODE). Meestal is dit een verouderde GitHub-login. " +
               "Oplossing: draai 'git credential-manager github login' en daarna dit script opnieuw. " +
               "Werkt dat niet, verwijder dan alle github.com-items in Windows Credentiebeheer en probeer opnieuw.")
    }

    Write-Host ""
    Write-Host "Klaar! Bekijk het resultaat op: $($RemoteUrl -replace '\.git$','')" -ForegroundColor Green
}
catch {
    $err = $_
    Write-Error "Push mislukt: $($err.Exception.Message)"
}
