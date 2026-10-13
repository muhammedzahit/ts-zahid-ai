# OSEM Bot — Proje Hafizasi

## Proje Neyle Ilgili
OSEM ekibi icin bir **Webex islem botu** (Node.js). Islemler: 1 gecici sifre,
2 prod DB SELECT, 3 Argo merge durumu, 4 merge notu birakma, 6 liquibase
calistir. (5, 7, 8, 9 islemleri 2026-10-13'te kaldirildi.)
Kullanicilar botu
bir Webex odasinda etiketleyip (mention) komut yazarlar; bot da tanimli
operasyonlari calistirir. Amac tekrarli operasyonel islemleri (sifre sifirlama, prod DB
sorgusu) Webex uzerinden guvenli sekilde yapabilmek.

## Mimari
- **index.js** — Webex bot giris noktasi. `webex-node-bot-framework` ile
  websocket modunda calisir (public URL / webhook gerekmez). Gelen mesaji
  parse eder (ilk satirin ilk kelimesi = komut, geri kalani = parametre) ve
  ilgili islemi cagirir. Parametre ayni satirda (`3 1`, `6 staging`) veya alt
  satirda yazilabilir; ikisi birden varsa alt satir kazanir (cok satirli SQL
  bozulmasin diye).
- **lib/tempPassword.js** — 1. islem. Admin ile login olup bearer token alir,
  ardindan gecici sifre degistirme endpoint'ine istek atar.
- **lib/dbQuery.js** — 2. islem. SELECT dogrulama + transaction/rollback ile
  sorgu calistirma + Excel export (SHARED_FOLDER'a).
- **lib/mergeControl.js** — 3. islem. Argo (OpenShift GitOps) login akisini
  (redirect takibi + login formu + cookie jar) yurutup `argocd.token` alir,
  ardindan `hasaroto` uygulamasinin `status.health.status` degerini dondurur
  (Healthy / Progressing / ...). CommonJS, sifir harici bagimlilik.
- **lib/mergeNotes.js** — 4. islem. Bir sonraki merge icin birakilan notlarin
  JSON dosya destekli deposu (`data/mergeNotes.json`, env ile
  `MERGE_NOTES_FILE` degistirilebilir). `addNote`, `listNotes`, `clearNotes`,
  `formatNotes`. Tek ortak havuz (grup ayrimi yok), sifir harici bagimlilik.
- **lib/liquibaseRun.js** — 6. islem. `backend-liquibase-2` calisma kopyasini
  `prod` branch'ine alip gunceller, changelog klasorunu `liquibase-spring`
  projesine robocopy `/MIR` ile aynalar, sonra o projenin `run.cmd`'sini
  cagirip ciktisini ayristirir. Sifir harici bagimlilik (`child_process`).
  Ayni anda iki calistirmayi engelleyen `mesgulMu()` kilidi var.
- **lib/permissions.js** — grup bazli yetkilendirme. `.env`'deki
  `WEBEX_ROOM_ID_<GRUP>` / `WEBEX_ROOM_ID_<GRUP>_YETKILER` degiskenlerinden
  roomId → izinli komut seti haritasi cikarir (`loadRoomPermissions`,
  `isAllowed`). Saf fonksiyonlar, test-offline.js'te test ediliyor.
- **.env** — tum sirlar ve baglanti bilgileri burada (git'e girmemeli).

## Islemler
### 1 — Gecici Sifre Degistirme (30 sn)
Girdi:
```
1
kullanici@ornek.com
```
Akis:
1. `PROD_LOGIN_URI`'ye `{username: PROD_ADMIN_USERNAME, password: PROD_ADMIN_PASSWORD}` POST → bearer token.
2. `PROD_LOGIN_URI` origin + `ADMIN_TEMPORARY_PASSWORD_URI`'ye Bearer token ile
   `{username: <girilen>, aesPassword: ADMIN_TEMPORARY_CHANGE_AES_PASSWORD}` POST.
3. Endpoint davranisi: istek gidince sifre HEMEN degisir; endpoint cevabi
   ~30 sn bekletir ve sure sonunda sifreyi ESKI haline geri alir. Akis: istek
   atilir, ilk ~2.5 sn'de hata gelmezse "gecici sifre olusturuldu, simdi giris
   yapabilirsiniz" mesaji atilir (onActive callback). Sonra ~30 sn'lik bekleme
   bitince "sure doldu, sifre geri alindi" mesaji atilir. (timeout 60 sn.)
   DIKKAT: ilk mesaj "degistiriliyor/bekleyin" DEGIL, dogrudan "olusturuldu"
   olmali — sifre istekle birlikte aktif oluyor.

Not: Login cevabindaki token alani kesin bilinmiyor; `token/accessToken/
access_token/data.token/jwt` alanlari sirayla deneniyor. Gercek alan netlesince
`lib/tempPassword.js` sadelestirilmeli.

### 2 — Prod DB SELECT Sorgusu
Girdi:
```
2
SELECT * FROM tablo WHERE ...
```
Akis:
1. Sorgu SELECT (veya WITH...) mi kontrol edilir; degilse Webex'e uyari atilir.
   Ek olarak coklu ifade ve yazma/DDL anahtar kelimeleri reddedilir.
2. Yine de guvenlik icin sorgu `BEGIN ... ROLLBACK` transaction'inda calistirilir
   (hicbir degisiklik kalici olmaz).
3. Sonuc `SHARED_FOLDER` icine `query_result_<timestamp>.xlsx` olarak yazilir.
4. Webex'e dosyanin tam (birlesik) yolu doner. Kullanicinin bilgisayari
   SHARED_FOLDER'a erisebiliyor.

DB baglantisi: `PROD_POSTGRES_IP/PORT/USERNAME/PORTGRES_PASSWORD/DB/SCHEMA`.
- `PROD_POSTGRES_DB` (=osem) pg `database` alani olarak kullanilir.
- `PROD_POSTGRES_SCHEMA` (=portal) baglantidan sonra `SET search_path TO "portal"`
  ile ayarlanir; boylece nitelenmemis tablo adlari dogru semada cozulur.
DIKKAT: env'de sifre degiskeni `PROD_PORTGRES_PASSWORD` (yazim hatasi "PORTGRES").

### 3 — Argo Merge Durumu
Girdi:
```
3
```
```
3 1        → kontrol araligi 1 dakika (alt satira da yazilabilir)
```
Akis:
0. ONCE bekleyen merge notlari (4. islem) kontrol edilir: en az bir not varsa
   "⚠️ DIKKAT — bu merge icin birakilan notlar" listesi gruba atilir ve notlar
   temizlenir. Notlar Argo cagrisindan once gosterilir; Argo'ya ulasilamasa
   bile release alan kisi notlari gorur.
1. `lib/mergeControl.js` > `ArgoControl()` Argo'ya login olur ve `hasaroto`
   uygulamasinin health durumunu dondurur.
2. `Healthy` → "su anlik devam eden bir merge yok" mesaji, islem biter.
3. `Progressing` → "merge devam ediyor, bitene kadar N dakikada bir bildirim
   atilacak" mesaji + oda bazli takip baslar (index.js > `startMergeWatch`,
   `mergeWatchers` Map: roomId → `{timer, dakika}`). Her kontrolde durum hala
   Progressing ise gruba "devam ediyor" bildirimi atilir; Healthy olunca
   "merge tamamlandi" mesaji atilip takip otomatik durur. Kontrol hatasinda
   hata mesaji atilir, takip devam eder.
   **Kontrol araligi:** varsayilan **3 dakika**; komutun yanina dakika yazarak
   degistirilebilir (`3 1` → 1 dk). Sinir 1-60 dk, ondalik kabul edilir
   (`1,5` / `1.5`). Gecersiz deger → uyari mesaji + varsayilan 3 dk.
   Ayni odada tekrar `3` yazilirsa ikinci timer kurulmaz; parametresiz `3`
   mevcut araligi korur, farkli bir dakika verilirse timer o aralikla yeniden
   kurulur ("aralik X dk → Y dk guncellendi").
   Parametre okuma `lib/parse.js` > `parseMergeInterval` (test-offline.js'te
   7 test); sabitler `MERGE_CHECK_DEFAULT_DK/MIN_DK/MAX_DK` orada.
4. Baska bir durum (Degraded vb.) oldugu gibi gosterilir.

Env: `ARGO_USERNAME`, `ARGO_PASSWORD`. Argo sunucusu
(`openshift-gitops-server-...apps.gbzocpbm01.trs.local`) sadece ic agdan
erisilebilir; disaridan canli test mumkun degil.

### 4 — Merge Notu Birakma
Girdi:
```
4
Cache temizlensin
```
Akis:
1. Not `lib/mergeNotes.js` > `addNote` ile kaydedilir; yazar adi Webex profil
   adindan (`trigger.person.displayName`, yoksa `personEmail`) alinir.
2. Bota "📝 Not kaydedildi (bekleyen not: N)" onayi doner.
3. Notlar `data/mergeNotes.json` icinde tutulur — pm2 restart'inda kaybolmaz.
   Dosya git'e girmez (`.gitignore` > `data/`).
4. Bekleyen notlar 3. islem calistirildiginda "kisi — not" listesi olarak
   gruba yansitilir ve AYNI ANDA temizlenir (notlar birikmez, her `3` listeyi
   sifirlar). Periyodik merge takip bildirimlerinde not gosterilmez.
5. Ikinci satir bossa kullanim ornegi doner. Not sayaci (id) temizleme sonrasi
   sifirlanmaz.

Amac: release/merge alan kisiye "sunu unutma" notlarinin sohbet icinde
kaybolmadan, tam merge aninda onune gelmesi.

### 6 — Liquibase Calistir
Girdi:
```
6
staging
```
```
6
prod
```
Akis (her iki ortam icin ortak ilk adim):
1. `lib/liquibaseRun.js` > `changeloglariSenkronla()`:
   `backend-liquibase-2` calisma kopyasi `prod` branch'ine alinir
   (`git checkout` + `git pull --ff-only`), sonra
   `service/src/main/resources/db/changelog` klasoru robocopy `/MIR` ile
   `liquibase-spring/src/main/resources/db/changelog` altina aynalanir
   (silinen dosyalar hedefte kalmaz). Gruba "N yeni commit cekildi → <sha>"
   ozeti yansitilir.
2. `liquibase-spring/run.cmd <profil> <mod>` calistirilir, cikti ayristirilir.

**staging** → dogrudan `update`. Uygulanan changeset'ler gruba **liste halinde**
yazilir (dosya :: id :: author :: exec tipi), ilk 25 tanesi gosterilir.

**prod** → once yalnizca `preview`: bekleyen changeset'ler listelenir,
uretilecek SQL bir dosyaya yazilir, **veritabanina hicbir sey yazilmaz**.
Uygulamak icin ayri bir mesaj gerekir:
```
6
onayla
```
- Onay penceresi **15 dk** (`PROD_ONAY_TTL_MS`), oda bazli, **tek kullanimlik**.
- `6` + `iptal` bekleyen onayi siler.
- Onay adiminda changelog **yeniden cekilmez** — onaylanan ile uygulanan ayni olsun.
- Bekleyen changeset yoksa onay istenmez, "prod zaten guncel" denir.
- Hata durumunda hatadan ONCE uygulanan changeset'lerin listesi + patlayan
  changeset'in kimligi doner (liquibase her changeset'i ayri commit eder).

Uygulanan changeset raporu Liquibase'in `ChangeExecListener`'i ile uretilir
(`UygulananDinleyici`), log satiri ayristirilarak DEGIL. Sebep: `ChangeSet ...
ran successfully` loglari onizleme modunda da basiliyor ve EXECUTED / MARK_RAN /
SKIPPED ayrimini vermiyor. Ozet `finally` icinde basildigi icin update ortada
patlasa bile o ana kadar uygulananlar raporlanir.

Ayni anda iki liquibase calistirilamaz (`mesgulMu()` kilidi).

Ayri proje: `C:\Users\T008356\Documents\Projeler\liquibase-spring`
(detay icin o projenin `README.md`'si). Onemli noktalar:
- **Veritabani bilgileri botun `.env`'inde DEGIL**, `liquibase-spring/.env`
  icindedir (`STAGING_DB_*` / `PROD_DB_*`); `run.cmd` oradan okur.
- **dropFirst her zaman `false`** — kodda sabit, ayardan degistirilemez, her
  calistirmada ciktida `DROP_FIRST: false` basilir.
- Liquibase **4.17.1**'e sabitli (uygulamanin `service/pom.xml`'i ile ayni).
  4.19+ "duplicate identifier" dogrulamasini sikilastirdi ve mevcut
  `changelog-master.xml` bu kontrolden GECMIYOR (35 changeset iki farkli
  master'dan ayni kimlikle include ediliyor).
- Prod'da uygulamanin kendisi liquibase'i calistirmiyor
  (`application-prod.yml` > `spring.liquibase.enabled: false`) — bu islem
  o manuel isin yerine geciyor.
- Prod URL'i uygulamanin ymlinden birebir alinamaz: oradaki `postgres-php`
  DNS adi yalnizca OpenShift icinden cozulur, `.env`'e IP yazilmistir.

Bot env: `LIQUIBASE_SOURCE_REPO`, `LIQUIBASE_SOURCE_BRANCH`,
`LIQUIBASE_PROJECT_DIR`, `LIQUIBASE_TIMEOUT_MS` (varsayilan 30 dk).

## Grup Bazli Yetkilendirme
Bot birden fazla gruba ekli; her grupta hangi islemlerin calisacagi `.env`'den
belirlenir:
```
WEBEX_ROOM_ID_GRUP1="Y2lzY29zcGFyazovL..."
WEBEX_ROOM_ID_GRUP1_YETKILER="all"        # veya "1,2,3"
WEBEX_ROOM_ID_GRUP2="Y2lzY29zcGFyazovL..."
WEBEX_ROOM_ID_GRUP2_YETKILER="3,4"
```
Yeni grup eklemek icin KOD DEGISIKLIGI GEREKMEZ: `lib/permissions.js` env'deki
tum `WEBEX_ROOM_ID_<GRUP>` anahtarlarini regex ile tarar, grup adi serbesttir.
`.env`'e iki satir + `pm2 restart osem-bot` yeterli.

Suanki canli dagilim (2026-09-11): GRUP1 `all`, GRUP2 `3,4,6`, GRUP3 `7`.
DIKKAT: 7. islem kaldirildi — GRUP3'te artik calisan islem yok; `.env`'de
GRUP3 satirlari guncellenmeli ya da silinmeli.

Kurallar:
- Eslesme room ID uzerinden yapilir (grup adi degisse de bozulmaz).
- `all` = tum islemler; virgullu liste = sadece o komutlar.
- Env'de tanimli olmayan oda/DM'lerden gelen mesajlar TAMAMEN yoksayilir
  (yanit yok, sadece console log). Bir DM'ye izin vermek gerekirse o DM'in
  room id'si de bir grup gibi tanimlanabilir.
- `_YETKILER` satiri unutulursa bot o grupta yanit verir ama hicbir islem
  calistirmaz ("yetkili islem tanimlanmamis" der) — konfig hatasi gorunur olsun.
- Menu (`islemler`) her grupta yalnizca izinli islemleri listeler; yetkisiz
  komut denemesine "⛔ ... bu grupta yetkili degil" doner.
- Duz `WEBEX_ROOM_ID` (soneksiz) grup sayilmaz, kodda kullanilmiyor.
- Baslangicta `initialized` logunda yuklu gruplar ve yetkileri yazdirilir.

## Calistirma
Uretimde bot pm2 altinda calisir (dogrudan `npm start` KULLANMA — pm2'deki
kopya ile ayni anda iki bot calisir, mesajlar cift gider):
```
pm2 start ecosystem.config.js   # veya: npm run start:pm2
pm2 status                      # durum
npm run logs                    # canli log (pm2 logs osem-bot)
pm2 restart osem-bot            # yeniden baslat
```
Loglar `logs/osem-bot-out.log` ve `logs/osem-bot-error.log` dosyalarinda.
Otomatik baslama: `pm2-windows-startup` kurulu (HKCU Run kaydi) — kullanici
oturum actiginda pm2 kayitli listeyi (`pm2 save` ile `~/.pm2/dump.pm2`)
geri yukler. Makine reboot olunca oturum acilana kadar bot calismaz.
DIKKAT: `.env`'de en az bir `WEBEX_ROOM_ID_<GRUP>` tanimli olmali, yoksa bot
hicbir odayi dinlemez (baslangicta uyari loglanir).

## Bilinen Sinirlar
- `webex-node-bot-framework` 2.5.1'de kalindi: 3.0.0 Node >= 22 istiyor
  (makinede Node 20.16 var) ve 2.x serisinin son surumu zaten 2.5.1.
  Framework, webex SDK'yi tam `2.60.0`'a sabitliyor; bu SDK uzun calismada
  bellek sizdiriyor (mercury/websocket olay cache'i sinirsiz buyuyor).
  Cozum operasyonel: pm2 `max_memory_restart: 1G` esiginde temiz restart.
  Node 22'ye gecilebilirse framework 3.x'e guncellenmeli.
- Loglarda `wx-js-sdk Unable to generate SDK event ... memberships:created`
  uyarilari SDK icinden gelir (parse edilemeyen uyelik olayi), zararsizdir;
  ama cok sik goruluyorsa bot gereksiz odalardan cikarilmali (olay hacmi
  bellek buyume hizini artiriyor).
- pm2'nin Windows'ta `max_memory_restart` restart'i yarisa girebiliyor:
  bellek-limit worker'i ("Process X in a stopped status, starting it") ile
  normal stop/start akisi AYNI ANDA birer kopya baslatip pm2 sadece birini
  takip edebiliyor. Sonuc: pm2 listesinde gorunmeyen sahipsiz (orphan) bir
  bot kopyasi kalir ve HER MESAJA CIFT YANIT gider. `pm2 restart` duzeltmez
  (sadece takipli kopyayi oldurur).
  Tespit: `pm2 ls`'teki pid ile su listeyi karsilastir; fazlalik = orphan:
  `Get-CimInstance Win32_Process -Filter "Name='node.exe' AND CommandLine
  LIKE '%ProcessContainerFork%'" | Select ProcessId, CreationDate`
  Temizlik sirasi ONEMLI (bot online iken orphan'i oldurme — daemon'daki
  bayat exit-dinleyicisi "uygulamam oldu" sanip YENI bir kopya baslatiyor,
  eski takipli kopya bu kez orphan kaliyor = kisir dongu):
  1) `pm2 stop osem-bot`  2) orphan PID'i `Stop-Process -Force` ile oldur
  3) tekrar listele, yeni kopya dogmadigini gor  4) `pm2 start osem-bot`.

## Yeni Islem Ekleme (ilerisi icin)
- `lib/` altina yeni bir modul ekle (ornek: `lib/yeniIslem.js`).
- `index.js` icindeki `switch (command)` blokina yeni bir `case` ekle.
- `OPERATIONS` dizisine `{ cmd, menuText }` maddesi ekle (menu buradan uretilir).
- Gerekli gruplarin `.env`'deki `_YETKILER` listesine yeni komutu ekle.
- Bu dosyayi (memory.md) guncelle.

## Yapilanlar / Durum
- [2026-10-13] **5, 7, 8 ve 9. islemler kaldirildi.** `index.js`'ten menu,
  handler ve switch kayitlari ile kopru odasi yonlendirmesi silindi;
  `lib/dbSor.js`, `lib/jiraSuggest.js`, `lib/makara.js`, `lib/kodSor.js` ve
  `roomid.js` silindi, test-offline.js'teki 7/8 testleri cikarildi.
  `.env.example`'tan `DB_SOR_URL`, `WEBEX_USER_TOKEN` ve `WEBEX_KOPRU_ODA_ID`
  atildi. Kodda okunmayan `WEBEX_CLIENT_ID/SECRET/REDIRECT_URI` ve islemi
  kalmayan `WEBEX_ROOM_ID_GRUP3(_YETKILER)` de `.env.example`'tan cikarildi.
  Asagidaki eski kayitlar tarihce olarak duruyor.
- [2026-09-12] **9. islem derinlestirildi: ajan artik KODU OKUYOR.**
  - Yeni `git_diff` araci: bir talebin fiili kod degisikligi. Buyuk talepte
    sayfalanir ("sayfa 2/5"), ajan sayfalari sirayla okuyup ozetliyor.
    Olculdu: `OPGP-491` (203 dosya, 16 commit) 7 baslikli ~2 sayfalik ozete
    indi, 175 sn / $1.65. Taleplerin %85'i <=20 dosya, tek sayfaya siğiyor.
  - **Gurultu suzgeci zorunluydu:** `externalservice/stubs/**` altindaki
    uretilmis SOAP stub'lari tek dosyada 513.458 satir. Lock dosyalari,
    `*.min.js`, binary'ler de cikariliyor — cikarildigi ciktida yaziliyor.
  - **TR/EN sozlugu** (`osem_kod_bot/lib/sozluk.js`, system prompt'a gomulu).
    Olculdu: kodda "iskonto" 100 dosya buluyor, "discount" 377, ortak 64 —
    yani tek dille arayan ilgili kodun ~%24'unu goruyordu. Ingilizce taraf kod
    tabaninin kendi paket adlarindan cikarildi. Otomatik genisletme YOK
    ("dosya"->"file" her Java dosyasini getirirdi), karar modele birakildi.
  - **Tarih duzeltmesi:** `ara --json` artik `created` de donduruyor. Oncelik
    commit tarihi > acilis > guncelleme. Sebep: `APTY-78767` 2025-09-29'da
    acilmis ama toplu statu degisimi yuzunden `updated` 2026-05-04 gorunuyor;
    ajan onceden "4 Mayis 2026'da yapildi" diyordu, artik sahte tarihi
    tespit edip belirtiyor.
  - `MAX_TURNS` 80, bot timeout 20 dk.
- [2026-09-12] **Guncelleme zamanlamasi kuruldu (crawler tarafi).**
  Iki Windows zamanlanmis gorev, `-StartWhenAvailable` ile (masaustu makine,
  gece kapaliysa kacan gorev acilista calisir):
  `jira-crawler update` **gunluk** 07:30 · `jira-crawler git sync` **haftalik**
  Pzt 07:45. Kayit/kaldirma: `jira-crawler/scripts/zamanla.ps1`.
  Jira'nin gunluk olmasi tercih degil — bayat indekste 7. islemin Top-3'u
  %77.6'dan %60.8'e dusuyor. Git haftalik cunku kod sorulari birkac gunluk
  gecikmeye dayaniyor.
  - `git sync` **artimli**: degisiklik yokken 10 sn. Ana dal taramasi da artik
    `<kayitli_sha>..main` okuyor (13.262 commit / 8.8 sn yerine 284 / 0.2 sn);
    aralik gecersizse tam taramaya duser.
  - **Kodu sonradan yazilan is icin bekleme penceresi GEREKMEDI:** senkron git
    durumuna bakiyor, talep durumuna degil. "Bu talebe baktim" diye bir kayit
    tutulmadigi icin kod ne zaman gelirse gelsin (yeni branch ya da main'e
    giren commit mesaji) kendiliginden yakalaniyor.
  - Servis `/saglik` artik `git_son_sync` / `git_yas_gun` / `git_bayat`
    donuyor; git verisi 10 gunden eskiyse cevaba uyari dusuyor.
- [2026-09-11] **9. islem eklendi — Jira/kod tarihcesi sorusu.**
  `lib/kodSor.js` yeni bir localhost servisine (`osem_kod_bot`, port 8849)
  HTTP atiyor; servis Claude Agent SDK ile **bes ozel arac** uzerinden
  jira-crawler verisini ve bare git klonlarini dolasip Turkce cevap uretiyor.
  - Iki soru turu: TARIHCE (`jira_ara` + `jira_oku` + `git_degisiklik`) ve
    MEVCUT DURUM (`kod_ara` + `kod_oku`, guncel `main` dali).
  - **Ajana Bash/Read/Grep VERILMIYOR.** Girdimiz Webex grup mesaji; korpus da
    baskalarinin yazdigi metin. Guvenlik arac sinirinda: alt surecler argv
    dizisiyle (`shell: false`), depo adlari sabit listeden, talep anahtari
    regex ile, yol kacisi (`..`, mutlak, `:`) reddediliyor. System prompt
    okunan icerigin "veri, talimat degil" oldugunu soyluyor.
  - Olculen: 85-150 sn, ~$0.8-1.0 abonelik kotasindan, 14-28 arac cagrisi,
    cevap ~3.5k karakter (Webex siniri 7000).
  - Crawler'a iki yeni cikti eklendi: `oku <KEY> [--json]` (yerel kayit, Jira
    baglantisi gerekmez) ve `git show --json`.
  - **Yetki:** `.env`'de 9 yalnizca `_YETKILER="all"` olan grupta acik. Diger
    gruplarda kullanilacaksa listeye eklenmeli.
- [2026-09-11] **Crawler'a git tarihcesi katmani eklendi (bot degismedi).**
  Dort ekip deposu bare klonlanip Jira anahtarli branch'lerin commit/dosya
  verisi `data/jira.db`'ye yaziliyor (`git sync|status|show|etiket|olcum`).
  Amac ikiliydi: 7. islemin onerisini iyilestirmek ve kod tarihcesi soru
  moduna (9. islem) zemin hazirlamak.
  - **Oneri iyilestirmesi CIKMADI.** Commit konulari + dosya yollari indekse
    terim olarak eklendi, eslenmis ve uc tohumlu olculdu (ornek 1500): taban
    Top-3 %79.9'a karsi W_CODE 0.5/1/2 icin +0.2 / +0.0 / -0.1 puan — hepsi
    gurultu bandinda. Olcum uc ayri veri kalitesinde tekrarlandi (%3.3, %7.7,
    %23.5 kapsama), sonuc degismedi. Agirlik **0'da birakildi**. Projede
    ogrenilen siralayici ve LLM yeniden siralama da ayni kapidan gecip
    reddedilmisti.
  - **Jira atanani = kodu yazan kisi, %91.7 oraninda** (1455 talepte).
    Yani onerinin ETIKETLERI GURULTULU DEGIL; Top-3 %74.9 kotu etiketlerden
    kaynaklanmiyor. Bu, arastirilacak bir yolu kapatan bulgu.
  - **Iki olcum tuzagi kayda gecti** (detay: crawler README "Git tarihcesi").
    (1) `main..branch` araligi baskalarinin commit'lerini tasiyor. (2) Merge
    edilen isin branch araligi BOSALIYOR (3240 branch'in 2155'i), yani
    tamamlanmis isler gorunmuyordu; ana dal ayrica taranip anahtar commit
    mesajindan okunuyor. Ikisi kapanmadan once ayni olcum %39.3 veriyordu —
    ara sayilar Jira hakkinda DEGIL, atif hatasinin buyuklugu hakkindaydi.
  - Kazanim: `git show <ANAHTAR>` bir talebin kim/ne zaman/hangi dosya
    hikayesini basiyor. Soru modunun veri kaynagi hazir.
- [2026-09-11] **7. islem artik anahtar kelimeyle de aranabiliyor.**
  `7 ekspertiz-kati-rapor-json` gibi, elde Jira numarasi olmadan "bu isi kim
  yapar?" sorusu. Crawler'a `suggest --metin "<kelimeler>"` eklendi (`key`
  artik `nargs="?"`; ikisi birden verilirse hata). Bot tarafinda
  `parametreyiCoz` anahtar bulamazsa yazilanlari arama metni sayiyor —
  ONCEDEN ilk kelimeyi anahtar sanip "Gecersiz talep anahtari" diyordu.
  Metin modunda proje uzmanligi hesaplanamadigi icin aday satirlarindan
  `proje %` kaldirildi (herkeste `%0` cikip hata gibi gorunuyordu) ve indekste
  karsiligi olmayan kelimeler ciktida listeleniyor. Anahtarli akis degismedi.
  test-offline.js 114 -> 135 test (hepsi PASS); crawler'in kendi 133 testi de
  gecti. Crawler README'sinde `suggest` bolumu guncellendi.
- [2026-09-11] **8. islem eklendi — makara (botlar arasi kopru).**
  `lib/makara.js`: `8 <metin>` denince metin kopru odasinda (`Botlarim`)
  `MakaraMıyızAbi` botu ETIKETLENEREK yazilir, cevabi beklenip istegi atan
  gruba **kaynak belirtilmeden** (botun kendi sozu gibi) dondurulur —
  ilk surumde `🎭 MakaraMıyızAbi diyor ki:` basligi vardi, kullanici ayni
  gun kaldirtti; bekleme mesaji da kopruyu anmiyor. Hedef bot oda
  uyeliklerinden adiyla bulunuyor (kodda id yok); canli dogrulandi:
  oda "Botlarim", uyeler ZahidAI / MakaraMıyızAbi / kullanici.
  `index.js`'te kopru odasi mesajlari komut olarak DEGERLENDIRILMEZ, yalnizca
  bekleyen makaraya verilir (dongu riski). test-offline.js'e 15 test eklendi
  (ad sadelestirme, etiket enjeksiyonu, cevap temizleme, oda sahiplenme),
  toplam 114 test gecti. `.env`'e `WEBEX_KOPRU_ODA_ID` eklendi (bilerek
  `WEBEX_ROOM_ID_*` kalibinda DEGIL — yoksa grup sanilirdi).
  Cevap yakalama kanali olcumle bulundu: ilk tasarim "karsi bot bizi
  etiketler" varsayimina dayaniyordu, canli testte karsi bot **thread'e
  etiketsiz** cevap verdi. Bot token'in `parentId` ile kendi thread'ini
  listeleyebildigi gorulunce asil kanal buna cevrildi — boylece kullanici
  token'i (suresi dolmus) gerekmiyor. Zaman asimi 150 sn (olculen cevap
  ~53 sn), yoklama araligi 6 sn (3 sn'de 429 yiyordu).
- [2026-09-11] **GRUP3 eklendi** (`.env`: `WEBEX_ROOM_ID_GRUP3` +
  `_YETKILER="7"`) — yalnizca 7. islem (talep atama onerisi) calisiyor. Kodda
  degisiklik gerekmedi; `loadRoomPermissions` grup adini regex'ten okudugu icin
  yeni grup otomatik tanindi. `pm2 restart osem-bot --update-env` sonrasi log
  "Grup yuklendi: GRUP3 -> yetkiler: 7" dedi, test-offline.js tamami gecti.
  NOT: ayni duzenlemede GRUP2 yetkileri `3,4,6,7` -> `3,4,6` oldu, yani 7 artik
  GRUP2'de kapali. Room id `roomid.js` ile uretildi (Webex link'indeki `space=`
  uuid'sini base64'e cevirir, padding'i atar).
- [2026-09-10] 7. isleme `full` modu eklendi ve benzer islerin BASLIKLARI ciktiya
  kondu (anahtar tek basina anlamsizdi). Ozet 3 kisi/3 dayanak, full tum adaylar +
  8 dayanak. Crawler'a bunun icin `suggest --similar N` bayragi eklendi.
  test-offline.js'e 12 test eklendi (parametre cozumleme + cikti bicimi).
- [2026-09-10] **Guncellik agirligi** eklendi (en buyuk tek kazanc): her isin oyu
  yasina gore azaliyor, 90 gunde yariya iniyor. Son 3 ayin talepleri uzerinde
  Top-1 %41.4 -> %46.5. Ayni calismada **ek dosya icerikleri** okunmaya baslandi
  (.docx/.xlsx stdlib ile, .pdf/.msg opsiyonel kutuphaneyle; gorseller OCR
  gerektirdigi icin atlaniyor). Metin `attachment_texts` tablosunda saklaniyor
  ama ONERIDE KULLANILMIYOR: ek metni olan 91 is uzerinde denenen hicbir
  yapilandirma (kirpma uzunlugu, sadece aciklamasiz islerde uygulama) "kapali"yi
  gecemedi. Cikarim hatalari (XML sizintisi, e-posta imzasi, tekrar eden kalip
  satirlar) duzeltildikten SONRA da gecemedi - dokumanlar KONUYU anlatiyor ama
  konu ekipte ortak, KIMIN yaptigini ayirt etmiyor. Veri arama/arsiv icin duruyor;
  acmak icin crawler'da `W_ATTACHMENT_TEXT = 1.0`.
- [2026-09-10] Oneri motoruna **baglam** eklendi: islerin %60'i alt gorev ve
  %17'sinin kendi aciklamasi bos oldugu icin UST TASK icerigi indekse katildi
  (Top-1 %51.7 -> %54.9). Ek dosya adlari ve bagli jiralar olculdu, katkisi
  gurultu sinirinda kaldi ama zarar vermedigi icin acik birakildi. ALT GOREV
  icerigi denendi ve KAPATILDI (zarar veriyor: alt gorevler baska kisilere
  dagitildigi icin ust task'i yanlis kisiye cekiyor). Ayrica sorgu tarafindaki
  baglam eksigi giderildi — canli cekilen talep de artik ayni baglami aliyor.
- [2026-09-10] **7. islem eklendi — talep atama onerisi.** `lib/jiraSuggest.js`
  ayri bir Python projesini (`jira-crawler`) alt surec olarak cagirip
  `7 APTY-125305` icin en olasi 3 kisiyi doner. Anahtar regex ile dogrulanir.
  Crawler tarafinda `suggest --json` bayragi bunun icin eklendi (giris
  mesajlari stdout'u kirletmesin diye sessiz mod ile). GRUP1 `all` oldugu icin
  yeni islemi otomatik gordu; GRUP2 yetkileri `3,4,6` — 7 gerekiyorsa
  `.env`'deki `WEBEX_ROOM_ID_GRUP2_YETKILER` listesine eklenmeli.
- [2026-08-21] 3. islemin kontrol araligi 5 dk → **3 dk** yapildi ve komut
  parametresiyle ayarlanabilir oldu (`3 1` → 1 dk). Bunun icin `parseInput`
  degisti: artik ilk satirin **ilk kelimesi** komut, kalani parametre — yani
  `6 staging`, `1 abc@ornek.com` gibi tek satirlik kullanimlar da calisiyor
  (alt satir varsa o kazanir, cok satirli SQL bozulmasin). Yeni
  `lib/parse.js` > `parseMergeInterval` (1-60 dk, ondalik ve `,` kabul,
  gecersizse uyari + varsayilan). `mergeWatchers` artik `{timer, dakika}`
  tutuyor; parametresiz `3` aktif takibin araligini degistirmez, farkli
  dakika verilirse timer yeniden kurulur. Menu metni guncellendi.
  test-offline.js: 6 yeni parse testi + 7 aralik testi (60/60 PASS).
  Canlida Webex'ten dogrulanmadi — `pm2 restart osem-bot` gerekiyor.
- [2026-08-18] 6. islem eklendi: Liquibase Calistir. Yeni ayri proje
  `C:\Users\T008356\Documents\Projeler\liquibase-spring` (Spring Boot 3.5.9,
  web'siz, liquibase 4.17.1, JBR 21 + IntelliJ'in bundled maven'i ile
  `build.cmd` / `run.cmd`). Bot tarafi: `lib/liquibaseRun.js`, index.js'e
  `case '6'`, `handleOperationSix`, `handleLiquibaseOnay`, menu maddesi;
  `.env`'e `LIQUIBASE_*` yollari. Onizleme modu `SpringLiquibase.performUpdate`
  override edilerek yazildi — normal kurulumun aynisi, sadece son adimda
  `update(..., Writer)`.
  Dogrulananlar (hepsi **sadece staging**, prod'a hic baglanilmadi):
  changelog senkronu (prod @ `dcb39f0f0a`), staging preview (0 bekleyen, 12 sn),
  staging update (0 uygulanan, 12 sn), her ikisi hem `run.cmd` hem bot modulu
  uzerinden. Onizlemenin DB'ye yazmadigi ayrica kanitlandi: sahte 2 changeset'lik
  gecici changelog ile preview alindi → `SELECT 1/2` **ve**
  `INSERT INTO portal.databasechangelog` satirlari dosyaya yazildi, ikinci
  preview hala "2 bekliyor" dedi (gecici dosya silindi). DIKKAT: preview
  modunda liquibase loglari yaniltici sekilde "ChangeSet ... ran successfully"
  basiyor — `LoggingExecutor` kullanildigi icin DB'ye gitmiyor.
  test-offline.js'e 11 cikti-ayristirma testi eklendi (hepsi PASS).
  **Canlida Webex'ten dogrulanmadi** ve **prod modu hic calistirilmadi** —
  `liquibase-spring/.env` icindeki `PROD_DB_*` degerleri kullanicinin teyidini
  bekliyor. GRUP1 `all` oldugu icin 6 aktif; **GRUP2 hala `"3,4"`**.
- [2026-08-18] 6. islem: sayi yerine **uygulanan changeset listesi** raporlanir
  oldu (kullanici istegi). `UygulananDinleyici` (liquibase `ChangeExecListener`)
  + `UygulamaSpringLiquibase` eklendi; `Ciktilar`'a `UYGULANAN_ADET`,
  `UYGULANAN`, `BASARISIZ_CHANGESET` girdi. Bot tarafinda liste ayristirilip
  mesajlara basiliyor (ilk 25). test-offline.js liquibase testleri 11 → 18.
  Dogrulama, staging'de **izole gecici sema** (`liquibase_dogrulama_tmp`)
  acilarak yapildi — `portal` semasina hic dokunulmadi, sema sonunda
  `DROP SCHEMA ... CASCADE` ile silindi:
  · 3 changeset'lik changelog → `UYGULANAN_ADET: 3`, ikisi `EXECUTED`,
    onkosulu tutmayan `MARK_RAN` olarak dogru raporlandi.
  · Ortasi patlayan 4 changeset'lik changelog → `UYGULANAN_ADET: 2` + iki
    `UYGULANAN` satiri + `BASARISIZ_CHANGESET` + cikis kodu 1. Yani prod'da
    yarim kalan bir update'te ne uygulandigi kesin bilinecek.
- [2026-08-03] 5. islem eklendi: DB Sorusu Sor. `lib/dbSor.js` (axios ile
  localhost:8848'e POST), index.js'e `case '5'`, `handleOperationFive` ve menu
  maddesi. `.env`'e `DB_SOR_URL` eklendi. GRUP1 zaten `all` oldugu icin aktif;
  **GRUP2 hala `"3,4"` — istenirse `"3,4,5"` yapilmali.**
  Servis ayri projede: `C:\Users\T008356\Desktop\osem_db_bot` (pm2: `osem-db-bot`),
  861 tabloluk bilgi tabani + Claude Agent SDK, abonelik kotasindan calisir.
  8 altin soruyla dogrulandi (uretilen SQL'ler prod'da EXPLAIN edildi) + uctan
  uca test yapildi. Canlida Webex'ten dogrulanmadi.
- [2026-08-03] `messageFormat: 'markdown'` framework config'ine eklendi
  (`index.js:13`). Onceden belirtilmedigi icin varsayilan `'text'` idi ve
  1-4. islemlerin `**kalin**` / ``` bloklari Webex'te HAM METIN olarak
  gidiyordu. Simdi hepsi duzgun render oluyor — 5. islemin ```sql bloklarinin
  renklenmesi icin de gerekliydi.
- [2026-07-31] 4. islem eklendi: Merge Notu Birakma. `lib/mergeNotes.js`
  (JSON dosya destekli ortak not havuzu, `data/mergeNotes.json`), index.js'e
  `case '4'`, menu maddesi ve 3. islemin basina "bekleyen notlari goster +
  temizle" adimi. `.env`'de GRUP2 yetkileri `"3"` → `"3,4"` (GRUP1 zaten `all`),
  `.gitignore`'a `data/` eklendi. test-offline.js'e 8 not testi + 2 yetki testi
  eklendi (33/33 PASS). Canlida dogrulanmadi (Webex gerekiyor) — kullanici
  `pm2 restart osem-bot` sonrasi grupta test edecek.
- [2026-07-13] Ilk surum yazildi: iki islem, menu, memory.md. Login token alan
  adi ve gecici sifre endpoint cevap yapisi canlida dogrulanmali.
- [2026-07-13] Mention duzeltmesi: grup odasinda "@bot islemler" yazilinca
  mesaj metnine botun gorunen adi da giriyordu ("OSEM Bot islemler"). Metnin
  basindaki bot adi artik ayiklaniyor (`lib/parse.js` > `stripBotMention`).
  Bot adi metnin ortasinda/SQL icinde geciyorsa dokunulmuyor. Parse mantigi
  test edilebilirlik icin `lib/parse.js`'e tasindi; testler `test-offline.js`.
- [2026-07-13] Newline duzeltmesi: mention'li mesajlarda Webex `text` alanini
  HTML'den turetiyor ve shift+enter satir sonlari kayboluyordu. Artik mesajda
  `html` alani varsa `lib/parse.js` > `htmlToText` ile parse ediliyor:
  `<br/>` ve blok kapanislari (`</p>` vb.) newline'a cevriliyor, botun kendi
  spark-mention'i siliniyor, HTML entity'leri (&lt; &amp; &#39; ...) decode
  ediliyor — SQL'deki `<`, `&`, `'` karakterleri icin onemli.
- [2026-07-16] 3. islem eklendi: Argo Merge Durumu. `lib/mergeControl.js`
  kullanici tarafindan eklendi; index.js'e `case '3'`, menu maddesi ve 5 dk'lik
  takip dongusu yazildi. mergeControl.js'e zorunlu duzeltmeler yapildi (dosya
  bu haliyle hic yuklenemiyordu): import/export → require/module.exports
  (Node 20.16, CommonJS paket icinde .js ESM yuklenmiyor), fonksiyon `async`
  yapildi, fazladan `)` kaldirildi, son API istegi Promise ile sarilip
  `status.health.status` gercekten return edilir hale getirildi. Login/cookie
  mantigina dokunulmadi. Canlida dogrulanmadi (ic ag gerekiyor).
- [2026-07-16] Grup bazli yetkilendirme eklendi (`lib/permissions.js` +
  index.js). Gruplar `.env`'de `WEBEX_ROOM_ID_<GRUP>` (room id) ve
  `WEBEX_ROOM_ID_<GRUP>_YETKILER` ("all" | "1,2,3") ile tanimlanir; tanimsiz
  oda/DM'ler hic dinlenmez, menu gruba gore filtrelenir, yetkisiz komuta ⛔
  mesaji doner. Statik MENU yerine OPERATIONS dizisi + buildMenu(perm).
  spawn selamlamasi sadece tanimli gruplarda. test-offline.js'e 8 yetki
  testi eklendi (hepsi PASS). Kullanicinin .env'e gercek room id'leri ve
  yetki satirlarini eklemesi gerekiyor; canli test kullanicida.
- [2026-07-22] Duplike mesaj arizasi cozuldu. Kok neden: 21 Temmuz 17:58'de
  `max_memory_restart` tetiklenince pm2'nin Windows restart yarisi (bkz.
  "Bilinen Sinirlar") sahipsiz ikinci bir bot kopyasi birakmis; ~28 saat iki
  bot ayni odalari dinleyip her mesaja cift yanit atmis. Orphan'i dogrudan
  oldurunce pm2 bayat exit-dinleyicisiyle yeni kopya baslatti (dongu bir tur
  tekrarladi); stop → orphan kill → start sirasiyla temizlendi, bot tek kopya
  olarak dogrulandi. Kod degismedi. Onlem onerisi: ecosystem.config.js'e
  gecelik `cron_restart` eklenirse bellek 1GB esigine nadiren ulasir ve bu
  yaris yolu nadiren tetiklenir (henuz uygulanmadi).
- [2026-07-17] Bot ~26 saat calistiktan sonra heap OOM ile coktu (webex SDK
  2.60.0 bellek sizintisi, bkz. "Bilinen Sinirlar"). Onlem: pm2 kuruldu,
  `ecosystem.config.js` eklendi (`max_memory_restart: 1G`, autorestart,
  loglar `logs/` altinda), bot pm2 altina alindi ve baslangic dogrulandi
  ("OSEM bot baslatildi ve dinlemede", GRUP1/GRUP2 yuklendi). `pm2 save` +
  `pm2-windows-startup` ile oturum acilisinda otomatik baslama kuruldu.
  package.json'a `start:pm2` ve `logs` scriptleri eklendi. Kod degismedi.
