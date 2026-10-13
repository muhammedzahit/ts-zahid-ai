@echo off
REM ============================================================================
REM  liquibase-spring - calistirma
REM
REM  Kullanim:  run.cmd PROFIL MOD
REM    PROFIL : staging veya prod   (hangi veritabanina baglanilacagi)
REM    MOD    : preview veya update (preview yalnizca SQL uretir, DB'ye yazmaz)
REM
REM  Onsart: build.cmd bir kere calistirilmis olmali (target\lib dolu olmali).
REM  Changelog dosyalari src\main\resources\db\changelog altinda beklenir;
REM  bunlari backend-liquibase-2 deposundan senkronlamak cagiranin isidir
REM  (OSEM botunda lib\liquibaseRun.js yapiyor).
REM
REM  NOT: REM satirlarinda kucuktur/buyuktur/dikey-cizgi karakterleri
REM  kullanilmaz - cmd bunlari yonlendirme sanip hata verir.
REM ============================================================================
setlocal
cd /d "%~dp0"

set "PROFIL=%~1"
set "MOD=%~2"

if "%PROFIL%"=="" goto :kullanim
if "%MOD%"=="" goto :kullanim
if /i not "%PROFIL%"=="staging" if /i not "%PROFIL%"=="prod" goto :kullanim
if /i not "%MOD%"=="preview" if /i not "%MOD%"=="update" goto :kullanim

REM Veritabani bilgileri .env dosyasindan gelir; ymldeki ${...} yer tutucularini
REM Spring bu ortam degiskenlerinden cozer. Delayed expansion KAPALI birakildi ki
REM sifrelerdeki unlem isareti bozulmasin.
if not exist ".env" (
    echo SONUC: HATA
    echo HATA_MESAJI: .env dosyasi yok - .env.example kopyalanip doldurulmali.
    exit /b 1
)
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"

if "%LIQUIBASE_JAVA_HOME%"=="" set "LIQUIBASE_JAVA_HOME=C:\Program Files\JetBrains\IntelliJ IDEA 2025.2.1\jbr"
if "%LIQUIBASE_MAVEN_HOME%"=="" set "LIQUIBASE_MAVEN_HOME=C:\Program Files\JetBrains\IntelliJ IDEA 2025.2.1\plugins\maven\lib\maven3"
set "JAVA_HOME=%LIQUIBASE_JAVA_HOME%"

if not exist "target\lib" (
    echo SONUC: HATA
    echo HATA_MESAJI: target\lib yok - once build.cmd calistirilmali.
    exit /b 1
)
if not exist "src\main\resources\db\changelog\changelog-master.xml" (
    echo SONUC: HATA
    echo HATA_MESAJI: changelog dosyalari yok - src\main\resources\db\changelog bos.
    exit /b 1
)

REM Silinmis changelog'lar target'ta kalmasin diye kopya tamamen yenilenir.
if exist "target\classes\db" rmdir /s /q "target\classes\db"

REM Kaynaklari (changelog + yml) target\classes'a kopyalar, degisen java varsa derler.
REM -o (offline): build.cmd sonrasi her sey .m2'de cachelidir, aga cikilmaz.
call "%LIQUIBASE_MAVEN_HOME%\bin\mvn.cmd" -o -B -q compile
if errorlevel 1 (
    echo SONUC: HATA
    echo HATA_MESAJI: Maven compile basarisiz - changelog/kaynak kopyalanamadi.
    exit /b 1
)

"%JAVA_HOME%\bin\java.exe" -Dfile.encoding=UTF-8 ^
    -cp "target\classes;target\lib\*" ^
    tr.com.osm.liquibase.LiquibaseRunnerApp ^
    --spring.profiles.active=%PROFIL% ^
    --osem.liquibase.mode=%MOD%
exit /b %ERRORLEVEL%

:kullanim
echo SONUC: HATA
echo HATA_MESAJI: Kullanim: run.cmd [staging^|prod] [preview^|update]
exit /b 2
