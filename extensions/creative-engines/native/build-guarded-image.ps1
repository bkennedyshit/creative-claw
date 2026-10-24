param(
    [Parameter(Mandatory = $true)][string]$EngineSource,
    [Parameter(Mandatory = $true)][string]$BuildDirectory,
    [string]$OnnxRuntimeRoot
)
$ErrorActionPreference = 'Stop'
$engineDirectory = (Resolve-Path -LiteralPath $EngineSource).Path
$buildTarget = [IO.Path]::GetFullPath($BuildDirectory)
$sourceTarget = Join-Path $engineDirectory 'dll_build'
if (-not (Test-Path -LiteralPath (Join-Path $sourceTarget 'CMakeLists.txt'))) { throw 'EngineSource must contain dll_build/CMakeLists.txt and the GAP-2 ONNX model host.' }
$configureArguments = @('-S', $sourceTarget, '-B', $buildTarget, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', "-DCMAKE_PROJECT_INCLUDE=$PSScriptRoot/guarded-segment.cmake")
if ($OnnxRuntimeRoot) { $configureArguments += "-DONNXRUNTIME_ROOT=$OnnxRuntimeRoot" }
& cmake @configureArguments
if ($LASTEXITCODE -ne 0) { throw 'Guarded native bridge configuration failed' }
& cmake --build $buildTarget --parallel 4
if ($LASTEXITCODE -ne 0) { throw 'Guarded native bridge build failed' }
Write-Output "Built guarded image bridge in $buildTarget. Stop the Gateway before installing it; preserve the existing DLL and matching ONNX Runtime/model files."
