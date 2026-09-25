<#
PowerShell version of fix_customer_csv
Reads layer JS files under layers\, extracts the "features" array, parses JSON, computes simple centroid,
builds an index mapping normalized city||district||ward keys to centroids, then reads data\customer.csv,
replaces invalid coordinates (0;0 or non-numeric) with matched centroids, and writes data\customer_fixed.csv.

Run from project root (C:\laragon\www\qgis):
.
PS> .\resources\fix_customer_csv.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$layerFiles = @("$projectRoot\\layers\\surabaya_2.js", "$projectRoot\\layers\\SIDOARJO_1.js")
$inputCsv = Join-Path $projectRoot 'data\customer.csv'
$outputCsv = Join-Path $projectRoot 'data\customer_fixed.csv'

$CityKeys = @('CITY','KAB','KOTA','KABUPATEN','PROVINSI','PROP','PROPINSI','ADM1_NAME')
$DistrictKeys = @('DISTRICT','KECAMATAN','KEC','ADM2_NAME')
$WardKeys = @('WARD','KELURAHAN','DESA','GAM','NAMOBJ','NAME','NM_KEL','ADM3_NAME')

function Normalize-Name {
    param([string]$s)
    if (-not $s) { return '' }
    $t = $s.ToUpper()
    $t = [regex]::Replace($t, '^(KAB\.?|KABUPATEN\.?|KOTA\.?|PROVINSI\.?|PROP\.?)+', '')
    $t = [regex]::Replace($t, '[^A-Z0-9 ]+', ' ')
    $t = [regex]::Replace($t, '\s+', ' ').Trim()
    return $t
}

function Sanitize-NumberString {
    param([string]$s)
    if ($null -eq $s) { return [double]::NaN }
    $t = $s.Trim()
    if ($t -eq '') { return [double]::NaN }
    $t = $t -replace '\s+', ''
    $t = $t -replace ',', '.'
    $t = [regex]::Replace($t, '[^0-9.\-]+', '')
    # collapse multiple dots
    $parts = $t -split '\.'
    if ($parts.Length -gt 2) {
        $first = $parts[0]
        $dec = ($parts[1..($parts.Length-1)] -join '')
        $t = "$first.$dec"
    }
    try { $out = [double]$t } catch { return [double]::NaN }
    return [double]$out
}

function Extract-FeaturesJson {
    param([string]$filePath)
    if (-not (Test-Path $filePath)) { Write-Warning "Layer file not found: $filePath"; return $null }
    $text = Get-Content $filePath -Raw -ErrorAction Stop
    $idx = $text.IndexOf('features')
    if ($idx -lt 0) { Write-Warning "No 'features' token in $filePath"; return $null }
    $bracketIdx = $text.IndexOf('[', $idx)
    if ($bracketIdx -lt 0) { Write-Warning "No '[' after features in $filePath"; return $null }
    # walk to matching ]
    $i = $bracketIdx
    $depth = 0
    for (; $i -lt $text.Length; $i++) {
        $ch = $text[$i]
        if ($ch -eq '[') { $depth++ }
        elseif ($ch -eq ']') { $depth-- ; if ($depth -eq 0) { break } }
    }
    if ($i -ge $text.Length) { Write-Warning "Could not find matching ] in $filePath"; return $null }
    $featuresText = $text.Substring($bracketIdx, $i - $bracketIdx + 1)
    # wrap as {"features": <featuresText> }
    $wrapped = "{`"features`": $featuresText }"
    try {
        $json = $wrapped | ConvertFrom-Json -ErrorAction Stop
        return $json
    } catch {
        Write-Warning ("ConvertFrom-Json failed for {0}: {1}" -f $filePath, $_.Exception.Message)
        # try a relaxed attempt: replace single quotes with double (dangerous)
        $try2 = $wrapped -replace "'", '"'
        try { return $try2 | ConvertFrom-Json -ErrorAction Stop } catch { Write-Warning "Second JSON parse failed"; return $null }
    }
}

function Get-NumberFromToken {
    param([object]$tok)
    if ($tok -is [System.Array]) { return Get-NumberFromToken $tok[0] }
    try { return [double]$tok } catch { return [double]::NaN }
}

function Compute-CentroidSimple {
    param($feature)
    if (-not $feature) { return $null }
    $geom = $feature.geometry
    if (-not $geom) { return $null }
    $type = $geom.type
    $ring = $null
    if ($type -eq 'Polygon') { if ($geom.coordinates -is [System.Array] -and $geom.coordinates.Length -ge 1) { $ring = $geom.coordinates[0] } else { return $null } }
        elseif ($type -eq 'MultiPolygon') { if ($geom.coordinates -is [System.Array] -and $geom.coordinates.Length -ge 1 -and $geom.coordinates[0] -is [System.Array] -and $geom.coordinates[0].Length -ge 1) { $ring = $geom.coordinates[0][0] } else { return $null } }
    if (-not $ring) { return $null }
    $sx = 0.0; $sy = 0.0; $n=0
    foreach ($c in $ring) {
        if ($c.Count -lt 2) { continue }
        $x = Get-NumberFromToken $c[0]; $y = Get-NumberFromToken $c[1]
        if ([double]::IsNaN($x) -or [double]::IsInfinity($x) -or [double]::IsNaN($y) -or [double]::IsInfinity($y)) { continue }
        $sx = [double]$sx + $x; $sy = [double]$sy + $y; $n++
    }
    if ($n -eq 0) { return $null }
    $cx = [double]$sx / [double]$n
    $cy = [double]$sy / [double]$n
    return @($cx, $cy)
}

function Pick-Prop {
    param($props, [string[]]$candidates)
    if (-not $props) { return $null }
    foreach ($k in $candidates) {
        if ($props.PSObject.Properties.Name -contains $k) {
            $v = $props.$k
            if ($v -ne $null -and $v -ne '') { return [string]$v }
        }
    }
    # case-insensitive fallback
    $map = @{}
    foreach ($pn in $props.PSObject.Properties.Name) { $map[$pn.ToUpper()] = $props.$pn }
    foreach ($cand in $candidates) { $u = $cand.ToUpper(); if ($map.ContainsKey($u)) { $v = $map[$u]; if ($v -ne $null -and $v -ne '') { return [string]$v } } }
    return $null
}

# Load layers
$layers = @()
foreach ($lf in $layerFiles) {
    try {
        $j = Extract-FeaturesJson -filePath $lf
        if ($j -ne $null) { $layers += $j }
    } catch { Write-Warning ("Error loading {0}: {1}" -f $lf, $_) }
}
if ($layers.Count -eq 0) { Write-Host "No layers loaded; aborting."; return }

# Build ward index
$wardIndex = @{}
$indexed = 0
foreach ($layer in $layers) {
    foreach ($f in $layer.features) {
        $props = $f.properties
        $city = Pick-Prop -props $props -candidates $CityKeys
        $district = Pick-Prop -props $props -candidates $DistrictKeys
        $ward = Pick-Prop -props $props -candidates $WardKeys
        $nc = Normalize-Name $city
        $nd = Normalize-Name $district
        $nw = Normalize-Name $ward
        $cent = Compute-CentroidSimple -feature $f
        if ($cent -eq $null) { continue }
        $key = "$nc||$nd||$nw"
        if (-not $wardIndex.ContainsKey($key)) { $wardIndex[$key] = @{centroid=$cent; props=$props} }
        $k2 = "||$nd||$nw"
        if (-not $wardIndex.ContainsKey($k2)) { $wardIndex[$k2] = @{centroid=$cent; props=$props} }
        $k3 = "||$nd||"
        if (-not $wardIndex.ContainsKey($k3)) { $wardIndex[$k3] = @{centroid=$cent; props=$props} }
        $indexed++
    }
}
Write-Host "buildWardIndex: entries=$($wardIndex.Keys.Count) featuresIndexed=$indexed"

if (-not (Test-Path $inputCsv)) { Write-Host "Input CSV not found: $inputCsv"; return }
$raw = Get-Content $inputCsv -Raw -ErrorAction Stop
$lines = $raw -split "\r?\n"
if ($lines.Length -le 1) { Write-Host "CSV empty or only header"; return }
$headerLine = $lines[0]
$headers = $headerLine -split ';' | ForEach-Object { $_.Trim() }

function Find-HeaderIndex($headers, $candidates) {
    $low = $headers | ForEach-Object { $_.ToLower() }
    foreach ($cand in $candidates) {
        for ($i=0; $i -lt $low.Length; $i++) {
            if ($low[$i].Contains($cand)) { return $i }
        }
    }
    return -1
}

$latIdx = Find-HeaderIndex $headers @('latitude','lat','y')
$lonIdx = Find-HeaderIndex $headers @('longitude','lon','lng','x')
if ($latIdx -lt 0 -or $lonIdx -lt 0) { Write-Host "Could not find lat/lon columns. Headers:"; Write-Host ($headers -join ', '); return }
$wardIdx = Find-HeaderIndex $headers @('kelurahan','kel','desa','ward','village','nm_kel','nama_kel')
$districtIdx = Find-HeaderIndex $headers @('kecamatan','kec','district')
$cityIdx = Find-HeaderIndex $headers @('kota','kab','kabupaten','city')

$out = New-Object System.Collections.Generic.List[string]
$out.Add($headerLine)
$total=0; $changed=0; $resolved=0; $failures=0
$samples = New-Object System.Collections.ArrayList
for ($i=1; $i -lt $lines.Length; $i++) {
    $line = $lines[$i]
    if (-not $line -or $line.Trim() -eq '') { continue }
    $total++
    $cols = $line -split ';'
    $rawLat = if ($latIdx -lt $cols.Length) { $cols[$latIdx].Trim() } else { '' }
    $rawLon = if ($lonIdx -lt $cols.Length) { $cols[$lonIdx].Trim() } else { '' }
    $lat = Sanitize-NumberString $rawLat
    $lon = Sanitize-NumberString $rawLon
    $changedThis = $false
    if ([double]::IsNaN($lat) -or [double]::IsInfinity($lat) -or [double]::IsNaN($lon) -or [double]::IsInfinity($lon) -or ([math]::Abs($lat) -lt 1e-6 -and [math]::Abs($lon) -lt 1e-6)) {
        $wardVal = if ($wardIdx -ge 0 -and $wardIdx -lt $cols.Length) { $cols[$wardIdx] } else { '' }
        $districtVal = if ($districtIdx -ge 0 -and $districtIdx -lt $cols.Length) { $cols[$districtIdx] } else { '' }
        $cityVal = if ($cityIdx -ge 0 -and $cityIdx -lt $cols.Length) { $cols[$cityIdx] } else { '' }
        $nCity = Normalize-Name $cityVal; $nDistrict = Normalize-Name $districtVal; $nWard = Normalize-Name $wardVal
        $keyCandidates = @("$nCity||$nDistrict||$nWard","||$nDistrict||$nWard","||$nDistrict||")
        $matched = $null
        foreach ($k in $keyCandidates) { if ($wardIndex.ContainsKey($k)) { $matched = $wardIndex[$k]; break } }
        if (-not $matched) {
            # try loose substring match (normalized)
            foreach ($kv in $wardIndex.GetEnumerator()) {
                if ($nWard -ne '' -and $kv.Key -match $nWard) { $matched = $kv.Value; break }
            }
        }
        if (-not $matched -and $nWard -ne '') {
            # alphanumeric fallback: strip non-alnum and try contains
            $target = ($nWard -replace '[^A-Z0-9]','')
            if ($target -ne '') {
                foreach ($kv in $wardIndex.GetEnumerator()) {
                    $parts = $kv.Key -split '\|\|'
                    $kWard = $parts[2]
                    $kWardA = ($kWard -replace '[^A-Z0-9]','')
                    if ($kWardA -and ($kWardA.Contains($target) -or $target.Contains($kWardA))) { $matched = $kv.Value; break }
                }
            }
        }
        # last resort: use district-only centroid if present
        if (-not $matched -and $nDistrict -ne '') {
            $dk = "||$nDistrict||"
            if ($wardIndex.ContainsKey($dk)) { $matched = $wardIndex[$dk] }
        }
        if ($matched) {
            $lon = [double]$matched.centroid[0]
            $lat = [double]$matched.centroid[1]
            $resolved++
            $changedThis = $true
            if ($samples.Count -lt 50) { $samples.Add(@{line=$i+1; origLat=$rawLat; origLon=$rawLon; resLat=$lat; resLon=$lon; matchedProps=$matched.props}) | Out-Null }
        } else { $failures++ }
    }
    if ($changedThis) {
        if ($latIdx -lt $cols.Length) { $cols[$latIdx] = [string]$lat } else { while ($cols.Length -le $latIdx) { $cols += '' }; $cols[$latIdx] = [string]$lat }
        if ($lonIdx -lt $cols.Length) { $cols[$lonIdx] = [string]$lon } else { while ($cols.Length -le $lonIdx) { $cols += '' }; $cols[$lonIdx] = [string]$lon }
        $changed++
    }
    $out.Add(($cols -join ';'))
}

try {
    $out -join "\r\n" | Out-File -FilePath $outputCsv -Encoding utf8 -Force
    Write-Host "Wrote fixed CSV to $outputCsv"
} catch { Write-Host "Failed to write output CSV: $_" }

Write-Host "Summary: total=$total changed=$changed resolved=$resolved failures=$failures"
if ($samples.Count -gt 0) { Write-Host "Samples (up to 50):"; $samples | ConvertTo-Json -Depth 3 | Write-Host }
Write-Host "Done."