# liquibase-spring

OSEM changelog'larini **staging** veya **prod** veritabaninda calistiran kucuk,
web'siz bir Spring Boot uygulamasi.

Changelog'lar bu projenin kaynagi degildir — her calistirmada
`backend-liquibase-2` deposunun **`prod`** branch'indeki
`service/src/main/resources/db/changelog` klasorunden aynalanir
(`src/main/resources/db/changelog` git'e girmez).

Kullanan taraf: OSEM Webex botunun **6. islemi**
(`../lib/liquibaseRun.js`). Ayni komutlar elle de calistirilabilir.

---

## Kurulum (bir kere)

```
build.cmd
```

Java kaynaklarini `target\classes`'a derler, tum runtime bagimliliklarini
`target\lib`'e kopyalar. Sonrasinda `run.cmd` internete cikmadan calisir.

Java kodu degistirilirse `build.cmd` tekrar calistirilmalidir.

JDK ve Maven PATH'te olmadigi icin scriptler IntelliJ'in getirdiklerini
kullanir. Baska bir yer kullanilacaksa:

```
set LIQUIBASE_JAVA_HOME=C:\yol\jdk
set LIQUIBASE_MAVEN_HOME=C:\yol\maven
```

## Veritabani bilgileri

`.env.example` dosyasini `.env` adiyla kopyalayip doldurun. `run.cmd` bu dosyayi
okuyup ortam degiskenlerine yukler; ymldeki `${...}` yer tutucularini Spring
oradan cozer. `.env` git'e girmez.

```
STAGING_DB_URL=jdbc:postgresql://.../osem_test?currentSchema=portal
STAGING_DB_USERNAME=...
STAGING_DB_PASSWORD=...
STAGING_DB_SCHEMA=portal

PROD_DB_URL=...
PROD_DB_USERNAME=...
PROD_DB_PASSWORD=...
PROD_DB_SCHEMA=portal
```

Kurallar: `KEY=VALUE`, esittirin etrafinda bosluk yok, deger tirnak icinde degil.

> Uygulamanin kendi `application-prod.yml`'i `postgres-php` DNS adini kullanir;
> bu ad yalnizca OpenShift icinden cozulur. Buraya ofis agindan erisilen IP yazilir.

## Calistirma

```
run.cmd staging preview     # bekleyenleri listeler + SQL uretir, DB'ye YAZMAZ
run.cmd staging update      # bekleyenleri uygular
run.cmd prod    preview
run.cmd prod    update
```

`preview` modunda uretilen SQL `target\preview\onizleme-<profil>-<zaman>.sql`
dosyasina yazilir.

Cikis kodu: `0` basarili, `0` disi hata.

---

## Nasil calisiyor

| Dosya | Isi |
|---|---|
| `LiquibaseRunnerApp.java` | Web'siz Spring Boot girisi; context'i acar, kapatir, cikis kodunu belirler |
| `LiquibaseConfig.java` | `SpringLiquibase` bean'ini elle kurar; moda gore onizleme ya da uygulama sinifi |
| `OnizlemeSpringLiquibase.java` | `performUpdate` override — update yerine listele + SQL yaz |
| `UygulamaSpringLiquibase.java` | `performUpdate` override — dinleyici tak, sonra normal update |
| `UygulananDinleyici.java` | `ChangeExecListener` — uygulanan changeset'leri exec tipiyle toplar |
| `RunnerProperties.java` | `osem.liquibase.*` ayarlari (mode, change-log, default-schema, output-dir) |
| `Ciktilar.java` | Botun ayristirdigi `ANAHTAR: deger` satir onekleri |

Onizleme modu, normal `SpringLiquibase` kurulumunun aynisini kullanir
(ayni `SpringResourceAccessor`, ayni `classpath:` cozumlemesi, ayni sema
ayarlari); yalnizca son adimda `liquibase.update(..., Writer)` cagirir. Boylece
butun ifadeler — `DATABASECHANGELOG` insert'leri dahil — dosyaya yazilir,
veritabaninda calistirilmaz.

### Uygulanan changeset raporu

Update modunda `UygulananDinleyici` (Liquibase'in `ChangeExecListener`'i) her
changeset icin `ran(...)` callback'inden kimlik + exec tipini toplar ve sonda
`UYGULANAN:` satirlari olarak basar.

Log satirlari (`ChangeSet ... ran successfully`) bilerek KULLANILMIYOR:
bu loglar onizleme modunda da basiliyor (LoggingExecutor yuzunden yaniltici)
ve `EXECUTED` / `MARK_RAN` / `SKIPPED` ayrimini vermiyor.

Ozet `finally` icinde basilir: bir changeset patlarsa, ondan **once uygulanmis**
olanlar yine raporlanir (liquibase her changeset'i ayri commit eder) ve patlayan
changeset `BASARISIZ_CHANGESET:` satiriyla bildirilir.

### dropFirst

`LiquibaseConfig.DROP_FIRST` sabiti **her zaman `false`**. Ayardan okunmaz,
komut satirindan degistirilemez. Her calistirmada ciktida `DROP_FIRST: false`
satiri basilir.

### Liquibase surumu

`pom.xml` **4.17.1**'e sabitlenmistir — `backend-liquibase-2/service/pom.xml`
ile ayni surum. Daha yeni surumler (4.19+) "duplicate identifier"
dogrulamasini sikilastirdi ve mevcut `changelog-master.xml` bu kontrolden
gecmiyor (35 changeset ayni kimlikle iki farkli master'dan include ediliyor).
Amac uygulamanin yaptigini birebir tekrarlamak oldugu icin uygulamanin
surumunde kalindi. `service/pom.xml`'deki surum degisirse burasi da degismeli.

## Cikti satirlari

Bot bu onekleri ayristirir (`Ciktilar.java`); degistirilirse
`../lib/liquibaseRun.js` de guncellenmelidir.

```
PROFIL: staging
MOD: PREVIEW
URL: jdbc:postgresql://...
SEMA: portal
CHANGELOG: classpath:db/changelog/changelog-master.xml
DROP_FIRST: false
BEKLEYEN_ADET: 2                                      (preview)
BEKLEYEN: db/changelog/... :: <id> :: <author>        (preview)
SQL_DOSYASI: C:\...\target\preview\onizleme-....sql   (preview)
UYGULANAN_ADET: 3                                     (update)
UYGULANAN: db/changelog/... :: <id> :: <author> :: EXECUTED   (update)
BASARISIZ_CHANGESET: db/changelog/... :: <id> :: <author>     (update, hata)
SONUC: BASARILI
HATA_MESAJI: ...                                      (yalnizca hata)
```
