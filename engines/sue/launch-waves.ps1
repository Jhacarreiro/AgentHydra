# Launch several SUE waves at once, each a different errand, against the LIVE site.
#
# ⛔ EVERY WAVE GOES THROUGH `sue run` (sue/lib/door.mjs): the cannon refuses a wave it did not
# start, and `sue run` is what puts the wave on the Sue Manager's wall and in status/report/stop.
# Each wave is a roster errand ({target, scenario, personas}) written to a JSON file and handed to
# `sue.mjs run --json-file`, because PowerShell 5.1 mangles JSON quoted on a command line. `sue run`
# returns in a second and runs the wave detached and windowless; the cannon re-executes itself under
# fairjob above 8 Sues at once.
#
# ⛔ HIDDEN WINDOWS, LOGGED OUTPUT, FAIRJOB-WRAPPED. A wave is a long browser+model run and this box
# is shared: never -NoNewWindow (it pops a console on the owner's screen), never a bare load
# generator. Each wave writes its own log under tmp/sue-waves/ so a stuck one can be read without
# attaching to anything.
#
# Every Sue here makes her OWN real account through the public sign-up (real address, the code the
# site mails her, the welcome email), and return-login then signs her back in to it. There is no
# reuse or borrowed-session switch: the owner deleted that mode on 2026-09-22 ("all SUSE should
# fundamentally, simply, and correctly literally create real accounts").
# Without -Forever each wave runs every one of its personas once (--count = how many it names), so
# a launch ends in finished runs whose reports can be read, not an endless stream.
param([switch]$Forever, [int]$QueueMinutes = 180)

$repo = (Resolve-Path "$PSScriptRoot\..").Path
$targetName = if ($env:SUE_DREDD_TARGET) { $env:SUE_DREDD_TARGET } else { "connections" }
if ($targetName -notmatch "^[a-z0-9][a-z0-9_-]*$") { throw "Invalid target name: $targetName" }
$target = Get-Content -Raw (Join-Path $repo "targets\$targetName.json") | ConvertFrom-Json
$workspace = [IO.Path]::GetFullPath((Join-Path (Join-Path $repo "targets") $target.root))
$logDir = Join-Path $repo "tmp\sue-waves"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

# Each wave pairs an errand with personas who would plausibly have it. Since 2026-09-22 (the owner:
# "give more complex tasks to Sues and have them branch out and explore our website and give full
# fledged feedback") the waves are the multi-leg errands: each Sue makes her own account, then works
# through several jobs across the whole site with her own patience on each leg (scenario "legs"),
# and answers the errand's own exit questions beside the standard ones. The single-job errands
# (put-my-business-in, share-your-card, walk-the-welcome, ...) still run by hand with the cannon.
# Concurrency sums to 10 Sues; the memory budget below launches as many as fit, in this order.
$waves = @(
  @{ target = "connections"; scenario = "explore-everything";        personas = "grandma,tiktok,dev-dan,esl-maria";          concurrency = 2 },
  @{ target = "connections"; scenario = "run-my-week";               personas = "office-manager,solo-consultant,shop-owner"; concurrency = 2 },
  @{ target = "connections"; scenario = "grow-my-business";          personas = "shop-owner,solo-consultant,tiktok";         concurrency = 2 },
  @{ target = "connections"; scenario = "plan-and-promote-an-event"; personas = "bob,elaine,old-sue";                        concurrency = 2 },
  @{ target = "connections"; scenario = "switch-from-my-tools";      personas = "karen,low-attention,dev-dan";               concurrency = 1 },
  @{ target = "connections"; scenario = "look-after-my-account";     personas = "old-sue,grandma,karen";                     concurrency = 1 }
)

# ⛔ THE LAUNCHER FITS FREE MEMORY, NOT THE LIST (owner, 2026-09-21: "you are killin my pc"). The
# cannon sizes ONE wave to free memory, but five cannons each doing that all see the same free
# memory and together take five times it: on 2026-09-22 five waves launched on 3.5 GB free. Same
# measured costs as cannon.mjs's waveCeiling - each wave owns one browser (~1 GB) plus ~400 MB per
# Sue, and 6 GB stays with the human. Waves launch in list order while they fit; the first always
# launches, trimmed to one Sue if that is all there is room for.
#
# A wave that does not fit WAITS instead of being dropped (2026-09-22: 9 GB free fitted one wave of
# six, and the other five were skipped). Every 2 minutes the launcher reads free memory again and
# starts what now fits; after a launch it waits 5 minutes first, because a new wave's browser and
# brains take that long to reach their real size and an early read would count memory they are
# about to use. Queued waves give up after -QueueMinutes (default 3 hours). Run it hidden with its
# own log (it waits): Start-Process powershell -WindowStyle Hidden -ArgumentList '-File ...'.#
# There is no account-headroom wait: the per-machine daily account cap it read was deleted on
# 2026-09-23 (sue/lib/run-dir.mjs says why), and the server's Sue door has no daily cap either.
# A cannon the door refuses (wrong key) stops by name in its own log.
$perSueMB = 400; $browserMB = 1024; $reserveMB = 6144
$launched = 0
$pending = [System.Collections.ArrayList]@($waves)
$deadline = (Get-Date).AddMinutes($QueueMinutes)
while ($pending.Count -gt 0) {
  $budgetMB = [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1KB) - $reserveMB
  $startedNow = 0
  foreach ($w in @($pending)) {
    $cost = $browserMB + $perSueMB * $w.concurrency
    if ($cost -gt $budgetMB) {
      if ($launched -gt 0) { continue }
      $w.concurrency = 1; $cost = $browserMB + $perSueMB
    }
    $budgetMB -= $cost; $launched++; $startedNow++
    [void]$pending.Remove($w)
    $names = @($w.personas -split ',')
    $wave = @{ target = $w.target; scenario = $w.scenario; personas = $names; concurrency = $w.concurrency; forever = [bool]$Forever }
    if (-not $Forever) { $wave.count = $names.Count }
    $argsFile = Join-Path $logDir "$stamp-$($w.scenario).json"
    [IO.File]::WriteAllText($argsFile, ($wave | ConvertTo-Json -Compress))
    # Stop a wave by its runId (`sue.mjs stop --json '{"runId":"..."}'` or the Manager's Stop), never
    # by a command-line pattern (on 2026-09-22 a pattern match stopped two other sessions' cannons).
    $answer = & node (Join-Path $repo "sue\sue.mjs") run --workspace $workspace --json-file $argsFile | ConvertFrom-Json
    if ($answer.ok) { Write-Output "$(Get-Date -Format HH:mm) launched $($w.scenario) [$($w.personas)] x$($w.concurrency) run $($answer.runId) -> $($answer.log)" }
    else { Write-Output "$(Get-Date -Format HH:mm) REFUSED $($w.scenario): $($answer.error)" }
  }
  if ($pending.Count -eq 0) { break }
  if ((Get-Date) -gt $deadline) { Write-Output "gave up waiting for memory: $(($pending | ForEach-Object { $_.scenario }) -join ', ')"; break }
  Write-Output "$(Get-Date -Format HH:mm) waiting ($budgetMB MB above the memory reserve):$(($pending | ForEach-Object { $_.scenario }) -join ', ')"
  Start-Sleep -Seconds $(if ($startedNow -gt 0) { 300 } else { 120 })
}
