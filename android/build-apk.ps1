$ErrorActionPreference = "Stop"

$androidDir = "D:\AppProject\quick-memo\android"
$sdkDir = "C:\Users\XUXU\AppData\Local\Android\Sdk"
$btDir = "$sdkDir\build-tools\36.1.0"
$androidJar = "$sdkDir\platforms\android-36\android.jar"

$aapt2 = "$btDir\aapt2.exe"
$d8 = "$btDir\d8.bat"
$zipalign = "$btDir\zipalign.exe"
$apksigner = "$btDir\apksigner.bat"

Write-Output "=== [1/6] Building Frontend & Bundling Single HTML ==="
Set-Location $androidDir
cmd /c "npm run build"
node "$androidDir\bundle-single-html.mjs"

$workDir = "$androidDir\build-tmp"
if (Test-Path $workDir) {
  Remove-Item -Recurse -Force $workDir
}
New-Item -ItemType Directory -Path "$workDir\res\drawable" -Force | Out-Null
New-Item -ItemType Directory -Path "$workDir\assets" -Force | Out-Null
New-Item -ItemType Directory -Path "$workDir\gen" -Force | Out-Null
New-Item -ItemType Directory -Path "$workDir\classes" -Force | Out-Null
New-Item -ItemType Directory -Path "$workDir\dex" -Force | Out-Null

Copy-Item "$androidDir\public\icons\icon.png" "$workDir\res\drawable\ic_launcher.png" -Force
Copy-Item "$androidDir\dist\index.html" "$workDir\assets\index.html" -Force

Write-Output "=== [2/6] Compiling & Linking Android Resources (aapt2) ==="
& $aapt2 compile --dir "$workDir\res" -o "$workDir\compiled_res.zip"

$unalignedApk = "$workDir\unaligned.apk"
& $aapt2 link `
  -I $androidJar `
  --manifest "$androidDir\native\AndroidManifest.xml" `
  -A "$workDir\assets" `
  --java "$workDir\gen" `
  -o $unalignedApk `
  "$workDir\compiled_res.zip"

Write-Output "=== [3/6] Compiling Java Sources (javac) ==="
$javaFiles = @(
  "$androidDir\native\src\com\quickmemo\android\MainActivity.java",
  "$workDir\gen\com\quickmemo\android\R.java"
)
& javac --release 11 -encoding UTF-8 -cp $androidJar -d "$workDir\classes" $javaFiles

Write-Output "=== [4/6] Converting Bytecode to DEX (d8) ==="
$classFiles = Get-ChildItem -Recurse -Filter "*.class" "$workDir\classes" | ForEach-Object { $_.FullName }
& $d8 --lib $androidJar --min-api 24 --output "$workDir\dex" $classFiles

Write-Output "=== [5/6] Adding classes.dex & Aligning APK (zipalign) ==="
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($unalignedApk, [System.IO.Compression.ZipArchiveMode]::Update)
[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
  $zip,
  "$workDir\dex\classes.dex",
  "classes.dex",
  [System.IO.Compression.CompressionLevel]::Optimal
) | Out-Null
$zip.Dispose()

$alignedApk = "$workDir\aligned.apk"
& $zipalign -f -p 4 $unalignedApk $alignedApk

Write-Output "=== [6/6] Signing APK (apksigner) ==="
$keystore = "$androidDir\native\quickmemo-release.keystore"
if (-not (Test-Path $keystore)) {
  & keytool -genkeypair `
    -keystore $keystore `
    -alias quickmemo `
    -keyalg RSA `
    -keysize 2048 `
    -validity 10000 `
    -storepass 123456 `
    -keypass 123456 `
    -dname "CN=QuickMemo, OU=TeaGoLab, O=QuickMemo, L=CN, S=CN, C=CN"
}

$finalApk = "$androidDir\QuickMemo.apk"
& $apksigner sign `
  --ks $keystore `
  --ks-key-alias quickmemo `
  --ks-pass pass:123456 `
  --key-pass pass:123456 `
  --out $finalApk `
  $alignedApk

Remove-Item -Recurse -Force $workDir
Write-Output "✅ APK Built Successfully: $finalApk ($((Get-Item $finalApk).Length) bytes)"
