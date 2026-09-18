@echo off
rem Builds the companion APK with the SDK command-line tools only: aapt2 + javac +
rem d8 + zipalign + apksigner. No Gradle, no network, no Kotlin.
rem
rem   companion\build.cmd            -> <repo>\dist\zapette-companion.apk
rem   companion\build.cmd --debug    keeps the intermediate tree at companion\build
rem
rem The Windows twin of companion\build.sh: same steps, same messages, same
rem intermediate layout, so the two can be read side by side. Three things differ
rem because Windows does: d8 and apksigner are .bat files and must be invoked with
rem `call` or cmd.exe exits after them; there is no `zip`, so classes.dex goes into
rem the APK through the .NET zip API; and cmd.exe has no `set -e`, so every tool
rem call is followed by an errorlevel check.
setlocal enabledelayedexpansion

set "here=%~dp0"
if "%here:~-1%"=="\" set "here=%here:~0,-1%"
for %%I in ("%here%\..") do set "root=%%~fI"
set "build=%here%\build"
set "out=%root%\dist\zapette-companion.apk"
set "ks=%USERPROFILE%\.zapette\android.keystore"

set "debug=0"
if "%~1"=="--debug" set "debug=1"

rem --- JDK 17 -------------------------------------------------------------------
set "JAVAC="
if defined JAVA_HOME if exist "%JAVA_HOME%\bin\javac.exe" set "JAVAC=%JAVA_HOME%\bin\javac.exe"
if not defined JAVAC call :try_java "%USERPROFILE%\.local\jdk\temurin-17"
for /d %%D in ("%ProgramFiles%\Eclipse Adoptium\jdk-17*") do if not defined JAVAC call :try_java "%%~fD"
for /d %%D in ("%ProgramFiles%\Java\jdk-17*") do if not defined JAVAC call :try_java "%%~fD"
for /d %%D in ("%ProgramFiles%\Microsoft\jdk-17*") do if not defined JAVAC call :try_java "%%~fD"
if not defined JAVAC (
  echo build.cmd: no JDK found. Install a JDK 17 and set JAVA_HOME to it.>&2
  exit /b 1
)

rem --- Android SDK ---------------------------------------------------------------
set "SDK="
if defined ANDROID_HOME call :try_sdk "%ANDROID_HOME%"
if not defined SDK if defined ANDROID_SDK_ROOT call :try_sdk "%ANDROID_SDK_ROOT%"
if not defined SDK call :try_sdk "%LOCALAPPDATA%\Android\Sdk"
if not defined SDK call :try_sdk "%USERPROFILE%\AppData\Local\Android\Sdk"
if not defined SDK (
  echo build.cmd: no Android SDK found. Set ANDROID_HOME, or install the SDK command-line tools and a platform and build-tools.>&2
  exit /b 1
)

rem Newest build-tools and platform by name, descending: 35.0.0 before 34.0.0.
set "BT="
for /f "delims=" %%D in ('dir /b /ad /o-n "%SDK%\build-tools" 2^>nul') do if not defined BT set "BT=%SDK%\build-tools\%%D"
set "PLATFORM="
for /f "delims=" %%D in ('dir /b /ad /o-n "%SDK%\platforms" 2^>nul ^| findstr /b "android-"') do if not defined PLATFORM set "PLATFORM=%SDK%\platforms\%%D"
set "ANDROID_JAR=%PLATFORM%\android.jar"

if not defined BT (
  echo build.cmd: no build-tools in %SDK%. Install them with sdkmanager.>&2
  exit /b 1
)
for %%T in ("%BT%\aapt2.exe" "%BT%\d8.bat" "%BT%\zipalign.exe" "%BT%\apksigner.bat") do (
  if not exist "%%~fT" (
    echo build.cmd: missing %%~fT - install build-tools with sdkmanager.>&2
    exit /b 1
  )
)
if not exist "%ANDROID_JAR%" (
  echo build.cmd: missing %ANDROID_JAR% - install a platform with sdkmanager.>&2
  exit /b 1
)

echo JAVA_HOME  !JAVA_HOME!
echo build-tools %BT%
echo platform   %PLATFORM%

rem --- signing key ---------------------------------------------------------------
if not exist "%ks%" (
  echo creating keystore %ks%
  if not exist "%USERPROFILE%\.zapette" mkdir "%USERPROFILE%\.zapette"
  call "!JAVA_HOME!\bin\keytool" -genkeypair -keystore "%ks%" ^
    -storepass android -keypass android -alias zapette ^
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=zapette-companion, O=zapette" >nul
  if errorlevel 1 (
    echo build.cmd: keytool could not create %ks%.>&2
    exit /b 1
  )
)

rem --- build ---------------------------------------------------------------------
if exist "%build%" rd /s /q "%build%"
mkdir "%build%" 2>nul
mkdir "%build%\res" 2>nul
mkdir "%build%\classes" 2>nul
mkdir "%build%\dex" 2>nul
mkdir "%root%\dist" 2>nul

echo aapt2 compile
call "%BT%\aapt2.exe" compile --dir "%here%\res" -o "%build%\res\res.zip"
if errorlevel 1 goto :failed

echo aapt2 link
call "%BT%\aapt2.exe" link ^
  -o "%build%\base.apk" ^
  -I "%ANDROID_JAR%" ^
  --manifest "%here%\AndroidManifest.xml" ^
  --min-sdk-version 30 --target-sdk-version 30 ^
  "%build%\res\res.zip"
if errorlevel 1 goto :failed

echo javac
dir /b /s "%here%\src\*.java" > "%build%\sources.txt"
if errorlevel 1 (
  echo build.cmd: no java sources under %here%\src.>&2
  exit /b 1
)
call "!JAVAC!" -nowarn --release 8 -cp "%ANDROID_JAR%" -d "%build%\classes" "@%build%\sources.txt"
if errorlevel 1 goto :failed

echo d8
dir /b /s "%build%\classes\*.class" > "%build%\classes.txt"
call "%BT%\d8.bat" --min-api 30 --lib "%ANDROID_JAR%" --output "%build%\dex" "@%build%\classes.txt"
if errorlevel 1 goto :failed

echo package
rem No `zip` on Windows: add classes.dex to the APK through the .NET zip API, which
rem is the equivalent of `zip -q -X base.apk classes.dex`.
set "BASE_APK=%build%\base.apk"
set "DEXFILE=%build%\dex\classes.dex"
if not exist "%DEXFILE%" (
  echo build.cmd: d8 produced no %DEXFILE%.>&2
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::Open($env:BASE_APK,'Update'); $e=$z.CreateEntry('classes.dex'); $s=$e.Open(); $b=[System.IO.File]::ReadAllBytes($env:DEXFILE); $s.Write($b,0,$b.Length); $s.Close(); $z.Dispose()"
if errorlevel 1 (
  echo build.cmd: could not add classes.dex to the APK ^(is PowerShell available?^).>&2
  exit /b 1
)

echo zipalign
call "%BT%\zipalign.exe" -f -p 4 "%build%\base.apk" "%build%\aligned.apk"
if errorlevel 1 goto :failed

echo apksigner
call "%BT%\apksigner.bat" sign ^
  --ks "%ks%" --ks-pass pass:android --key-pass pass:android --ks-key-alias zapette ^
  --out "%out%" "%build%\aligned.apk"
if errorlevel 1 goto :failed

call "%BT%\apksigner.bat" verify --print-certs "%out%"
if "%debug%"=="0" rd /s /q "%build%"

for %%F in ("%out%") do echo built %out% (%%~zF bytes)
endlocal
exit /b 0

:failed
echo build.cmd: the step above failed.>&2
exit /b 1

:try_java
if exist "%~1\bin\javac.exe" (
  set "JAVA_HOME=%~1"
  set "JAVAC=%~1\bin\javac.exe"
)
exit /b 0

:try_sdk
if exist "%~1\platforms" if exist "%~1\build-tools" set "SDK=%~1"
exit /b 0
