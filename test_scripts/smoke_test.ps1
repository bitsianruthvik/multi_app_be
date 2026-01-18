# smoke_test.ps1
# Usage: run from PowerShell while backend is running

$base = $env:BACKEND_URL -or "http://localhost:4000"
Write-Host "Using backend:" $base

function PostJson($path, $body) {
    $uri = "$base$path"
    Write-Host "POST" $uri
    try {
        $res = Invoke-RestMethod -Uri $uri -Method Post -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 5) -UseBasicParsing
        return $res
    } catch {
        Write-Error "Request failed: $_"
        return $null
    }
}

Write-Host "1) Test inline analysis"
$inline = PostJson "/api/analyze_inline" @{ transcription = "This is a short test transcript mentioning Oncaryva and a doctor." }
Write-Host "inline response:" ($inline | ConvertTo-Json -Depth 3)

Write-Host "\n2) Test enqueue by id (id=1) and poll status"
$enqueue = PostJson "/api/analyze_by_id_async" @{ id = 1 }
if (-not $enqueue) { Write-Error "Enqueue failed"; exit 1 }
Write-Host "enqueue response:" ($enqueue | ConvertTo-Json -Depth 3)
$jobId = $enqueue.job_id
if (-not $jobId) { Write-Error "No job_id returned"; exit 1 }

for ($i=0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 2
    try {
        $status = Invoke-RestMethod -Uri "$base/api/analysis_status?job_id=$jobId" -Method Get -UseBasicParsing
        Write-Host "poll #$i:" ($status | ConvertTo-Json -Depth 3)
        if ($status.status.status -in @('finished','failed')) { break }
    } catch {
        Write-Warning "status check failed: $_"
    }
}

Write-Host "Done"
