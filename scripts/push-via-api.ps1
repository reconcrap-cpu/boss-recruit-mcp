$ErrorActionPreference = 'Stop'
$repoPath = 'C:\Users\yaolin\Documents\codex_projects\boss-recruit-mcp'
$owner = 'reconcrap-cpu'
$repo = 'boss-recruit-mcp'
$branch = 'main'
$tag = 'v1.0.11'
$token = $env:GITHUB_TOKEN
if (-not $token) {
  throw 'Missing GITHUB_TOKEN environment variable'
}

$headers = @{
  Authorization = "Bearer $token"
  'User-Agent' = 'codex-release-bot'
  Accept = 'application/vnd.github+json'
}

function GhGet($url) {
  Invoke-RestMethod -Headers $headers -Uri $url -Method Get
}
function GhPost($url, $bodyObj) {
  $json = $bodyObj | ConvertTo-Json -Depth 100 -Compress
  Invoke-RestMethod -Headers $headers -Uri $url -Method Post -Body $json -ContentType 'application/json'
}
function GhPatch($url, $bodyObj) {
  $json = $bodyObj | ConvertTo-Json -Depth 100 -Compress
  Invoke-RestMethod -Headers $headers -Uri $url -Method Patch -Body $json -ContentType 'application/json'
}

$localHead = (git -C $repoPath rev-parse HEAD).Trim()
$localParent = (git -C $repoPath rev-parse HEAD~1).Trim()
$commitMessage = (git -C $repoPath log -1 --pretty=%B | Out-String).Trim()
if (-not $commitMessage) { $commitMessage = 'release: v1.0.11' }

$ref = GhGet ("https://api.github.com/repos/$owner/$repo/git/ref/heads/$branch")
$remoteHead = $ref.object.sha
if ($remoteHead -ne $localParent) {
  throw "Remote head mismatch. remote=$remoteHead localParent=$localParent"
}

$remoteCommit = GhGet ("https://api.github.com/repos/$owner/$repo/git/commits/$remoteHead")
$baseTree = $remoteCommit.tree.sha

$changeLines = git -C $repoPath diff-tree --no-commit-id --name-status -r HEAD
$treeEntries = @()

foreach ($line in $changeLines) {
  if (-not $line) { continue }
  $parts = $line -split "`t", 2
  if ($parts.Count -lt 2) { continue }
  $status = $parts[0].Trim()
  $pathRel = $parts[1].Trim()
  if (-not $pathRel) { continue }

  if ($status -eq 'D') {
    $treeEntries += @{ path = $pathRel; mode = '100644'; type = 'blob'; sha = $null }
    continue
  }

  $fullPath = Join-Path $repoPath $pathRel
  if (-not (Test-Path $fullPath)) { throw "missing file: $pathRel" }

  $modeLine = (git -C $repoPath ls-tree HEAD -- "$pathRel" | Out-String).Trim()
  $mode = '100644'
  if ($modeLine) { $mode = (($modeLine -split "\s+")[0]).Trim() }

  $bytes = [System.IO.File]::ReadAllBytes($fullPath)
  $base64 = [System.Convert]::ToBase64String($bytes)
  $blob = GhPost ("https://api.github.com/repos/$owner/$repo/git/blobs") @{ content = $base64; encoding = 'base64' }
  $treeEntries += @{ path = $pathRel; mode = $mode; type = 'blob'; sha = $blob.sha }
}

$newTree = GhPost ("https://api.github.com/repos/$owner/$repo/git/trees") @{ base_tree = $baseTree; tree = $treeEntries }
$newCommit = GhPost ("https://api.github.com/repos/$owner/$repo/git/commits") @{ message = $commitMessage; tree = $newTree.sha; parents = @($remoteHead) }
GhPatch ("https://api.github.com/repos/$owner/$repo/git/refs/heads/$branch") @{ sha = $newCommit.sha; force = $false } | Out-Null

$tagExists = $false
try { GhGet ("https://api.github.com/repos/$owner/$repo/git/ref/tags/$tag") | Out-Null; $tagExists = $true } catch {}
if (-not $tagExists) {
  GhPost ("https://api.github.com/repos/$owner/$repo/git/refs") @{ ref = "refs/tags/$tag"; sha = $newCommit.sha } | Out-Null
}

$release = $null
try {
  $release = GhGet ("https://api.github.com/repos/$owner/$repo/releases/tags/$tag")
} catch {
  $release = GhPost ("https://api.github.com/repos/$owner/$repo/releases") @{
    tag_name = $tag
    target_commitish = $branch
    name = $tag
    body = "Release $tag`n`n- npm package published: @reconcrap/boss-recruit-mcp@1.0.11`n- DOM-first favorite flow with calibration fallback`n- postinstall + runtime skill asset sync"
    draft = $false
    prerelease = $false
  }
}

[PSCustomObject]@{
  local_head = $localHead
  remote_parent = $remoteHead
  pushed_commit = $newCommit.sha
  release_url = $release.html_url
} | ConvertTo-Json -Depth 6
