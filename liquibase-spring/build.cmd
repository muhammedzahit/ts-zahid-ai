@echo off
REM ============================================================================
REM  liquibase-spring - kurulum / derleme (BIR KERE, ve Java kodu degisince)
REM
REM  Yaptigi is:
REM    1. Java kaynaklarini derler ......... target\classes
REM    2. Tum runtime bagimliliklarini ..... target\lib
REM  Boylece run.cmd her calistiginda internete/maven merkezine ihtiyac duymadan
REM  calisir (run.cmd maven'i offline modda cagirir).
REM
REM  JDK ve Maven yollari PATH'te olmadigi icin asagida acikca veriliyor;
REM  ortam degiskeni tanimlanmissa o kullanilir.
REM
REM  NOT: REM satirlarinda kucuktur/buyuktur/dikey-cizgi karakterleri
REM  kullanilmaz - cmd bunlari yonlendirme sanip hata verir.
REM ============================================================================
setlocal
cd /d "%~dp0"

if "%LIQUIBASE_JAVA_HOME%"=="" set "LIQUIBASE_JAVA_HOME=C:\Program Files\JetBrains\IntelliJ IDEA 2025.2.1\jbr"
if "%LIQUIBASE_MAVEN_HOME%"=="" set "LIQUIBASE_MAVEN_HOME=C:\Program Files\JetBrains\IntelliJ IDEA 2025.2.1\plugins\maven\lib\maven3"

if not exist "%LIQUIBASE_JAVA_HOME%\bin\java.exe" (
    echo [HATA] JDK bulunamadi: "%LIQUIBASE_JAVA_HOME%"
    echo        LIQUIBASE_JAVA_HOME ortam degiskeni ile dogru yolu verin.
    exit /b 1
)
if not exist "%LIQUIBASE_MAVEN_HOME%\bin\mvn.cmd" (
    echo [HATA] Maven bulunamadi: "%LIQUIBASE_MAVEN_HOME%"
    echo        LIQUIBASE_MAVEN_HOME ortam degiskeni ile dogru yolu verin.
    exit /b 1
)

set "JAVA_HOME=%LIQUIBASE_JAVA_HOME%"

echo [1/1] Maven: clean compile + bagimliliklar target\lib altina kopyalaniyor...
call "%LIQUIBASE_MAVEN_HOME%\bin\mvn.cmd" -B clean compile dependency:copy-dependencies -DoutputDirectory=target\lib -DincludeScope=runtime
if errorlevel 1 (
    echo [HATA] Maven derlemesi basarisiz.
    exit /b 1
)

echo.
echo [OK] Kurulum tamam. Artik run.cmd kullanilabilir:
echo      run.cmd staging preview
echo      run.cmd staging update
echo      run.cmd prod    preview
echo      run.cmd prod    update
exit /b 0
