# Deployment script for Azure Static Web Apps via GitHub
# Target repo: https://github.com/fiberteamwork/mapteam.git

$ErrorActionPreference = "Continue"

Write-Host "=== Checking git ==="
git --version

Write-Host "`n=== Initializing repository (if needed) ==="
if (-not (Test-Path ".git")) {
    git init -b main
} else {
    Write-Host ".git already exists"
}

Write-Host "`n=== Setting remote origin ==="
$remotes = git remote
if ($remotes -notcontains "origin") {
    git remote add origin https://github.com/fiberteamwork/mapteam.git
} else {
    git remote set-url origin https://github.com/fiberteamwork/mapteam.git
}

Write-Host "`n=== Remote URL ==="
git remote -v

Write-Host "`n=== Current branch ==="
git branch --show-current

Write-Host "`n=== Staging all files ==="
git add -A

Write-Host "`n=== Committing ==="
git commit -m "Deploy to Azure Static Web Apps - customer map"

Write-Host "`n=== Pushing to main ==="
git push -u origin main
