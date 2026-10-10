<#
  Drives REAL Excel for workbook-tests/cases/excel.mjs.

  Opens the exported workbook named in the job file, makes the edits a person makes (bottom-up, so the row numbers above each
  edit still mean what they meant), and saves it as .xlsx the way Excel writes it. Seat labels for the People, Responsibilities
  and Questions edits are read from what Excel itself offers in the drop-downs (the hidden Lists sheet), after the rows moved.

  Prints OK on success. Exits 3 with NO_EXCEL when Excel cannot be started. Any Excel this script started and did not manage to
  close is stopped at the end; an Excel that was already running is left alone.
#>
param([Parameter(Mandatory = $true)][string]$JobFile)

$ErrorActionPreference = 'Stop'
$started = Get-Date
$j = Get-Content -LiteralPath $JobFile -Raw | ConvertFrom-Json

try { $xl = New-Object -ComObject Excel.Application } catch { Write-Output 'NO_EXCEL'; exit 3 }

try {
  $xl.Visible = $false
  $xl.DisplayAlerts = $false
  $xl.AutomationSecurity = 3
  $wb = $xl.Workbooks.Open($j.inFile)
  $xl.Calculation = -4105   # automatic

  $s = $wb.Worksheets.Item('Structure')
  $p = $wb.Worksheets.Item('People')
  $r = $wb.Worksheets.Item('Responsibilities')
  $q = $wb.Worksheets.Item('Questions & doubts')
  $m = $wb.Worksheets.Item('Departments')
  $l = $wb.Worksheets.Item('Lists')
  $xlUp = -4162

  # ---- Structure, bottom-up ----
  $s.Rows.Item([int]$j.deleteRow).Delete() | Out-Null
  Write-Output "deleted Structure row $($j.deleteRow)"

  $s.Rows.Item([int]$j.copyRow).Copy() | Out-Null
  $s.Rows.Item([int]$j.copyRow + 1).Insert() | Out-Null     # inserts the copied cells: the Key travels with them
  Write-Output "copied row $($j.copyRow) into a new row below it"

  $s.Rows.Item([int]$j.insertAt).Insert() | Out-Null
  $s.Cells.Item([int]$j.insertAt, [int]$j.col.firstLevel + [int]$j.insertLevel - 1).Value2 = $j.insertTitle
  $s.Cells.Item([int]$j.insertAt, [int]$j.col.count).Value2 = 2
  $s.Cells.Item([int]$j.insertAt, [int]$j.col.shift).Value2 = $j.insertShift
  $s.Cells.Item([int]$j.insertAt, [int]$j.col.department).Value2 = $j.machineName
  Write-Output "inserted a seat at row $($j.insertAt)"

  $s.Cells.Item([int]$j.retitleRow, [int]$j.col.firstLevel + [int]$j.retitleLevel - 1).Value2 = $j.retitleTo
  Write-Output "retitled row $($j.retitleRow)"
  $s.Cells.Item([int]$j.countRow, [int]$j.col.count).Value2 = [int]$j.countTo
  Write-Output "headcount of row $($j.countRow) -> $($j.countTo)"

  # ---- the new machine (a department), then the sheets that name seats ----
  $lastM = $m.Cells.Item($m.Rows.Count, [int]$j.deptCol.name).End($xlUp).Row + 1
  $m.Cells.Item($lastM, [int]$j.deptCol.name).Value2 = $j.machineName
  $m.Cells.Item($lastM, [int]$j.deptCol.under).Value2 = $j.underName
  $m.Cells.Item($lastM, [int]$j.deptCol.type).Value2 = 'Machine / area'
  Write-Output "machine department added on Departments row $lastM"
  $xl.CalculateFull()

  $dash = [string][char]0x2014
  function Label-For([string]$title) {
    for ($i = 2; $i -le 1500; $i++) {
      $text = [string]$l.Cells.Item($i, 5).Text
      if ($text.EndsWith(" $dash $title")) { return $text }
    }
    throw "no seat label ends with '$title'"
  }

  $target = Label-For $j.targetTitle
  $p.Cells.Item([int]$j.personRow, 2).Value2 = $target
  Write-Output "person on People row $($j.personRow) now in: $target"

  $duty = Label-For $j.dutySeatTitle
  $lastR = $r.Cells.Item($r.Rows.Count, 2).End($xlUp).Row + 1
  $r.Cells.Item($lastR, 1).Value2 = $duty
  $r.Cells.Item($lastR, 2).Value2 = $j.dutyText
  Write-Output "duty added on Responsibilities row $lastR against: $duty"

  $q.Rows.Item([int]$j.questionDeleteRow).Delete() | Out-Null
  Write-Output "deleted Questions row $($j.questionDeleteRow)"
  $lastQ = $q.Cells.Item($q.Rows.Count, 2).End($xlUp).Row + 1
  $q.Cells.Item($lastQ, 2).Value2 = $j.questionText
  Write-Output "question added on row $lastQ"

  $wb.SaveAs($j.outFile, 51)   # xlOpenXMLWorkbook
  $wb.Close($false)
  Write-Output 'OK'
}
finally {
  $xl.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
  Start-Sleep -Seconds 2
  Get-Process EXCEL -ErrorAction SilentlyContinue |
    Where-Object { $_.StartTime -ge $started -and $_.MainWindowHandle -eq 0 } |
    Stop-Process -Force -ErrorAction SilentlyContinue
}
