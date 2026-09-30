param([string]$name="paper-git")
$all = Get-CimInstance Win32_Process
$roots = $all | Where-Object { $_.Name -ieq "$name.exe" }
if(-not $roots){ '{"n":0}'; exit }
$ids = New-Object System.Collections.Generic.HashSet[int]
function Walk($id){ if($ids.Add($id)){ $all | Where-Object { $_.ParentProcessId -eq $id } | ForEach-Object { Walk $_.ProcessId } } }
$roots | ForEach-Object { Walk $_.ProcessId }
$priv=@{}
(Get-Counter '\Process V2(*)\Working Set - Private' -ErrorAction SilentlyContinue).CounterSamples | ForEach-Object { if($_.InstanceName -match ':(\d+)$'){ $priv[[int]$Matches[1]]=$_.CookedValue } }
$p=0;$w=0;$k=0;$c=0;$n=0
foreach($i in $ids){ $x=Get-Process -Id $i -ErrorAction SilentlyContinue; if($x){ $n++; $p+=$priv[$i]; $w+=$x.WorkingSet64; $k+=$x.PeakWorkingSet64; $c+=$x.TotalProcessorTime.TotalSeconds } }
[pscustomobject]@{ n=$n; priv=[math]::Round($p/1MB,1); ws=[math]::Round($w/1MB,1); peak=[math]::Round($k/1MB,1); cpu=[math]::Round($c,2) } | ConvertTo-Json -Compress
