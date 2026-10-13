'use strict';

require('dotenv').config();

const Framework = require('webex-node-bot-framework');
const { changeTemporaryPassword } = require('./lib/tempPassword');
const { handleSelectQuery } = require('./lib/dbQuery');
const { stripBotMention, parseInput, htmlToText, parseMergeInterval } = require('./lib/parse');
const ArgoControl = require('./lib/mergeControl');
const { loadRoomPermissions, isAllowed } = require('./lib/permissions');
const { addNote, listNotes, clearNotes, formatNotes } = require('./lib/mergeNotes');
const { askDbQuestion } = require('./lib/dbSor');
const { askKodQuestion } = require('./lib/kodSor');
const {
  changeloglariSenkronla,
  liquibaseCalistir,
  mesgulMu: liquibaseMesgulMu,
} = require('./lib/liquibaseRun');
const {
  oneriAl: jiraOneriAl,
  formatla: jiraOneriFormatla,
  parametreyiCoz: jiraParametreyiCoz,
} = require('./lib/jiraSuggest');
const makara = require('./lib/makara');

const config = {
  token: process.env.WEBEX_BOT_TOKEN,
  // webhookUrl verilmedigi icin framework websocket modunda calisir (public URL gerekmez).
  // messageFormat varsayilani 'text'; belirtilmezse **kalin** ve ``` bloklari
  // Webex'te ham metin olarak gider. SQL bloklarinin renklenmesi icin gerekli.
  messageFormat: 'markdown',
};

// Grup bazli yetkiler (.env: WEBEX_ROOM_ID_<GRUP> + WEBEX_ROOM_ID_<GRUP>_YETKILER).
// Burada tanimli olmayan oda/DM'lerden gelen mesajlar tamamen yoksayilir.
const ROOM_PERMS = loadRoomPermissions(process.env);

const framework = new Framework(config);

framework.start();

framework.on('initialized', () => {
  console.log('OSEM bot baslatildi ve dinlemede.');
  if (ROOM_PERMS.size === 0) {
    console.log('UYARI: env\'de WEBEX_ROOM_ID_<GRUP> tanimi yok — bot hicbir odayi dinlemeyecek.');
  }
  for (const perm of ROOM_PERMS.values()) {
    const yetkiler = perm.all ? 'all' : ([...perm.allowed].join(',') || '(yok)');
    console.log(`Grup yuklendi: ${perm.group} → yetkiler: ${yetkiler}`);
  }
});

const OPERATIONS = [
  {
    cmd: '1',
    menuText:
      '**1 — Kullanicinin sifresini 30 saniyeligine degistir**\n' +
      'Kullanim (araya yeni satir birakin):\n' +
      '```\n1\nkullanici@ornek.com\n```',
  },
  {
    cmd: '2',
    menuText:
      '**2 — Prod DB\'de SELECT sorgusu calistir**\n' +
      'Kullanim (araya yeni satir birakin):\n' +
      '```\n2\nSELECT * FROM tablo WHERE ...\n```',
  },
  {
    cmd: '3',
    menuText:
      '**3 — Argo Merge Durumu**\n' +
      'Kullanim: sadece `3` yazin. Merge devam ediyorsa bitene kadar 3 dakikada bir gruba bildirim atilir.\n' +
      'Farkli aralik icin yaninda dakika yazin (1-60): `3 1` → 1 dakikada bir kontrol.',
  },
  {
    cmd: '4',
    menuText:
      '**4 — Bir sonraki merge icin not birak**\n' +
      'Kullanim (araya yeni satir birakin):\n' +
      '```\n4\nCache temizlensin\n```\n' +
      'Birakilan notlar 3. islem calistirildiginda gruba gosterilir ve listeden temizlenir.',
  },
  {
    cmd: '5',
    menuText:
      '**5 — DB sorusu sor (SQL uretir)**\n' +
      'Turkce soru sorun, calistirilabilir SELECT sorgusu ve aciklamasi donsun.\n' +
      'Kullanim (araya yeni satir birakin):\n' +
      '```\n5\nsu username\'e sahip kullanicinin yetkisi ne?\n```\n' +
      'Sorguyu bot calistirmaz; isterseniz donen SQL\'i **2. islemle** calistirabilirsiniz.',
  },
  {
    cmd: '6',
    menuText:
      '**6 — Liquibase calistir**\n' +
      'Changelog\'lar her calistirmada `backend-liquibase-2` deposunun `prod` branch\'inden guncellenir.\n' +
      'Kullanim (araya yeni satir birakin):\n' +
      '```\n6\nstaging\n```\n' +
      '```\n6\nprod\n```\n' +
      '`staging` → dogrudan uygulanir.\n' +
      '`prod` → once bekleyen changeset\'ler listelenir, hicbir sey yazilmaz; ' +
      'uygulamak icin `6` + `onayla`, vazgecmek icin `6` + `iptal`.',
  },
  {
    cmd: '7',
    menuText:
      '**7 — Talep kime atanabilir? (oneri)**\n' +
      'Talep anahtarini verin, gecmis islere bakip en olasi kisileri onersin.\n' +
      'Kullanim: `7 APTY-125305`\n' +
      'Talep anahtari yoksa anahtar kelimelerle de aranabilir:\n' +
      '`7 ekspertiz kati rapor json`\n' +
      'Tum adaylar ve daha fazla dayanak icin sonuna `full` ekleyin: ' +
      '`7 APTY-125305 full`\n' +
      'Alt satira da yazilabilir:\n' +
      '```\n7\nAPTY-125305\n```\n' +
      'Her oneride dayanak olarak benzer isler anahtar + basligiyla listelenir.\n' +
      'Oneri gecmis isleri baz alir; kisilerin o anki is yuku dikkate ALINMAZ.',
  },
  {
    cmd: '8',
    menuText:
      '**8 — Makara yap**\n' +
      'Istediginizi kopru odasindaki makara botuna ilettirir, cevabini buraya getirir.\n' +
      'Kullanim: `8 Ismail\'i zorbala`\n' +
      'Alt satira da yazilabilir:\n' +
      '```\n8\nIsmail\'i zorbala\n```',
  },
  {
    cmd: '9',
    menuText:
      '**9 — Jira/kod sorusu sor**\n' +
      'Gecmis talepleri ve kod tarihcesini tarayip Turkce cevap verir.\n' +
      'Iki tur soru sorabilirsiniz:\n' +
      '```\n9\niskontolarda son jiralarda hangi guncellemeler yapildi\n```\n' +
      '```\n9\niskonto sifirlama kurali eksper tarafinda nasil calisiyor\n```\n' +
      'Ilki gecmisi (hangi talepte ne degisti, kim, ne zaman), ikincisi ' +
      'guncel kodu anlatir.\n' +
      'Ajan kodu gercekten okuyup ozetliyor: cevap **birkac dakika** surebilir, ' +
      'buyuk taleplerde daha uzun. Dayanak olarak bakilan talepler listelenir.',
  },
];

function buildMenu(perm) {
  const items = OPERATIONS.filter((op) => isAllowed(perm, op.cmd));
  if (items.length === 0) {
    return '**OSEM Islem Botu** — bu grupta yetkili islem tanimlanmamis. (.env\'de `WEBEX_ROOM_ID_<GRUP>_YETKILER` satirini kontrol edin.)';
  }
  return (
    '**OSEM Islem Botu** — bu grupta yapilabilecek islemler:\n\n' +
    items.map((op) => op.menuText).join('\n\n') +
    '\n\nIslemleri gormek icin: `islemler`'
  );
}

async function handleOperationOne(bot, username) {
  if (!username) {
    await bot.say('1. islem icin ikinci satira kullanici adini (e-posta) girmelisiniz.\n\nOrnek:\n```\n1\nkullanici@ornek.com\n```');
    return;
  }

  try {
    await changeTemporaryPassword(username, {
      onActive: async () => {
        await bot.say(
          `✅ \`${username}\` icin gecici sifre olusturuldu — simdi giris yapabilirsiniz. Sifre ~30 saniye sonra geri alinacak.`
        );
      },
    });
    await bot.say(`⏱️ Sure doldu — \`${username}\` sifresi eski haline geri alindi.`);
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 400)}`
      : err.message;
    await bot.say(`❌ Sifre degistirme sirasinda hata olustu:\n\`\`\`\n${detail}\n\`\`\``);
  }
}

async function handleOperationTwo(bot, query) {
  if (!query) {
    await bot.say('2. islem icin ikinci satira SELECT sorgunuzu girmelisiniz.\n\nOrnek:\n```\n2\nSELECT * FROM tablo\n```');
    return;
  }

  await bot.say('Sorgu kontrol ediliyor ve transaction icinde (rollback ile) calistiriliyor...');

  try {
    const result = await handleSelectQuery(query);
    if (!result.ok) {
      await bot.say(`⚠️ ${result.reason}`);
      return;
    }
    await bot.say(
      `✅ Sorgu calistirildi (${result.rowCount} satir). Excel dosyasi olusturuldu:\n\`\`\`\n${result.fullPath}\n\`\`\``
    );
  } catch (err) {
    await bot.say(`❌ Sorgu calistirilirken hata olustu:\n\`\`\`\n${err.message}\n\`\`\``);
  }
}

// Takip araligi: varsayilan 3 dk, `3 <dakika>` ile odaya ozel degistirilebilir
// (parseMergeInterval + sinirlar lib/parse.js'te, test-offline.js'te test ediliyor).
const mergeWatchers = new Map(); // roomId -> { timer, dakika }

function stopMergeWatch(roomId) {
  const watcher = mergeWatchers.get(roomId);
  if (watcher) {
    clearInterval(watcher.timer);
    mergeWatchers.delete(roomId);
  }
}

function startMergeWatch(bot, dakika) {
  const roomId = bot.room.id;
  stopMergeWatch(roomId); // aralik degismis olabilir; eski timer birakilmaz

  const timer = setInterval(async () => {
    try {
      const status = await ArgoControl();

      if (status === 'Progressing') {
        await bot.say(`🔄 **Argo Merge Durumu:** merge hala devam ediyor (Progressing). ${dakika} dakika sonra tekrar kontrol edilecek.`);
        return;
      }

      stopMergeWatch(roomId);
      if (status === 'Healthy') {
        await bot.say('✅ **Argo Merge Durumu:** merge tamamlandi — uygulama Healthy.');
      } else {
        await bot.say(`⚠️ **Argo Merge Durumu:** takip sonlandi, beklenmeyen durum: \`${status || 'bilinmiyor'}\``);
      }
    } catch (err) {
      try {
        await bot.say(`⚠️ Argo merge kontrolu basarisiz oldu, ${dakika} dakika sonra tekrar denenecek:\n\`\`\`\n${err.message}\n\`\`\``);
      } catch (sayErr) {
        console.error('Merge takip mesaji gonderilemedi:', sayErr.message);
      }
    }
  }, dakika * 60 * 1000);

  mergeWatchers.set(roomId, { timer, dakika });
}

async function handleOperationThree(bot, rest) {
  const { dakika, uyari, verildi } = parseMergeInterval(rest);
  if (uyari) await bot.say(uyari);

  // Bekleyen merge notlari Argo cagrisindan ONCE gosterilir: Argo'ya
  // ulasilamasa bile release alan kisi notlari gormus olur.
  try {
    const notes = listNotes();
    if (notes.length > 0) {
      await bot.say(formatNotes(notes));
      clearNotes();
    }
  } catch (err) {
    console.error('Merge notlari gosterilemedi:', err.message);
  }

  let status;
  try {
    status = await ArgoControl();
  } catch (err) {
    await bot.say(`❌ Argo Merge Durumu alinamadi:\n\`\`\`\n${err.message}\n\`\`\``);
    return;
  }

  if (status === 'Healthy') {
    await bot.say('✅ **Argo Merge Durumu:** Healthy — su anlik devam eden bir merge yok.');
    return;
  }

  if (status === 'Progressing') {
    const mevcut = mergeWatchers.get(bot.room.id);

    if (mevcut && !verildi) {
      await bot.say(
        `🔄 **Argo Merge Durumu:** merge devam ediyor (Progressing). Takip zaten aktif, bitene kadar ${mevcut.dakika} dakikada bir bildirim atilmaya devam edilecek.`
      );
      return;
    }

    if (mevcut && mevcut.dakika === dakika) {
      await bot.say(
        `🔄 **Argo Merge Durumu:** merge devam ediyor (Progressing). Takip zaten ${dakika} dakikalik aralikla aktif.`
      );
      return;
    }

    // Yeni takip ya da kullanicinin verdigi yeni aralikla yeniden kurulum.
    startMergeWatch(bot, dakika);
    await bot.say(
      mevcut
        ? `🔄 **Argo Merge Durumu:** merge devam ediyor (Progressing). Kontrol araligi ${mevcut.dakika} dk → **${dakika} dk** olarak guncellendi.`
        : `🔄 **Argo Merge Durumu:** merge devam ediyor (Progressing). Bitene kadar ${dakika} dakikada bir bu gruba bildirim atilacak.`
    );
    return;
  }

  await bot.say(`⚠️ **Argo Merge Durumu:** \`${status || 'bilinmiyor'}\``);
}

async function handleOperationFour(bot, trigger, note) {
  if (!note) {
    await bot.say('4. islem icin ikinci satira notunuzu yazmalisiniz.\n\nOrnek:\n```\n4\nCache temizlensin\n```');
    return;
  }

  const author =
    (trigger.person && trigger.person.displayName) || trigger.personEmail || 'bilinmiyor';

  try {
    addNote({ author, text: note });
    const bekleyen = listNotes().length;
    await bot.say(
      `📝 Not kaydedildi (bekleyen not: ${bekleyen}). Bir sonraki 3. islemde release alan kisiye gosterilecek.`
    );
  } catch (err) {
    await bot.say(`❌ Not kaydedilemedi:\n\`\`\`\n${err.message}\n\`\`\``);
  }
}

async function handleOperationFive(bot, trigger, soru) {
  if (!soru || !soru.trim()) {
    await bot.say(
      '5. islem icin ikinci satira sorunuzu yazmalisiniz.\n\n' +
        'Ornek:\n```\n5\nsu username\'e sahip kullanicinin yetkisi ne?\n```'
    );
    return;
  }

  // Cevap 30-60 saniye surebiliyor; kullanici beklemede oldugunu bilsin.
  await bot.say('🔎 Bakiyorum, birkac saniye surebilir…');

  const kullanici = (trigger.person && trigger.person.displayName) || trigger.personEmail || null;
  // Oturum anahtari: ayni odada ayni kisinin devam sorulari baglama otursun.
  const oturum = `${bot.room.id}:${trigger.personId || trigger.personEmail || 'anon'}`;

  const { mesaj } = await askDbQuestion({ soru, kullanici, oturum });
  await bot.say(mesaj);
}

// --- 9. islem: Jira/kod tarihcesi sorusu -----------------------------------

async function handleOperationNine(bot, trigger, soru) {
  if (!soru || !soru.trim()) {
    await bot.say(
      '9. islem icin ikinci satira sorunuzu yazmalisiniz.\n\n' +
        'Ornek:\n```\n9\niskontolarda son jiralarda hangi guncellemeler yapildi\n```\n' +
        '```\n9\niskonto sifirlama kurali nasil calisiyor\n```'
    );
    return;
  }

  // Ajan talepleri bulup kodun DIFF'ini okuyor, buyuk taleplerde sayfa sayfa.
  // Bu birkac dakika surebiliyor; kullanici beklemede oldugunu bilsin.
  await bot.say(
    '🔎 Jira ve kod tarihcesini tariyorum, degisen kodu okuyorum… ' +
      'Birkac dakika surebilir.'
  );

  const kullanici = (trigger.person && trigger.person.displayName) || trigger.personEmail || null;
  // Oturum anahtari: ayni odada ayni kisinin devam sorulari baglama otursun.
  const oturum = `${bot.room.id}:${trigger.personId || trigger.personEmail || 'anon'}`;

  const { mesaj } = await askKodQuestion({ soru, kullanici, oturum });
  await bot.say(mesaj);
}

// --- 7. islem: Talep atama onerisi -----------------------------------------

async function handleOperationSeven(bot, talep) {
  const istek = jiraParametreyiCoz(talep);
  const { key: anahtar, metin, full } = istek;
  if (!anahtar && !metin) {
    await bot.say(
      '7. islem icin talep anahtarini ya da aranacak kelimeleri yazmalisiniz.\n\n' +
        'Ornek:\n```\n7 APTY-125305\n```\n' +
        'Talep anahtari yoksa kelimelerle de aranabilir:\n' +
        '```\n7 ekspertiz kati rapor json\n```\n' +
        'Tum adaylari gormek icin:\n```\n7 APTY-125305 full\n```'
    );
    return;
  }

  // Indeks kurulumu + gerekirse Jira'dan cekme birkac saniye surebiliyor.
  await bot.say(
    `🔎 ${anahtar ? anahtar.toUpperCase() : `"${metin}"`} icin gecmis isler taraniyor…` +
      (full ? ' (tam rapor)' : '')
  );

  try {
    const veri = await jiraOneriAl(istek, full);
    await bot.say(jiraOneriFormatla(veri, full));
  } catch (err) {
    await bot.say(`⚠️ Oneri alinamadi.\n\n${err.message}`);
  }
}

// --- 8. islem: Makara (botlar arasi kopru) ---------------------------------

async function handleOperationEight(bot, rest) {
  const metin = (rest || '').trim();
  if (!metin) {
    await bot.say(
      '8. islem icin makara metnini yazmalisiniz.\n\n' +
        'Ornek:\n```\n8 Ismail\'i zorbala\n```'
    );
    return;
  }

  if (makara.mesgulMu()) {
    await bot.say('⏳ Kopruden zaten bir makara bekleniyor. Cevap gelince tekrar deneyin.');
    return;
  }

  const botAdi = (framework.person && framework.person.displayName) || '';
  // Cevap LLM ile uretildigi icin ~1 dakika suruyor; kullanici beklemede
  // oldugunu bilsin. Kopru/karsi bot burada ANILMAZ (asagiya bakin).
  await bot.say('🎭 Bir saniye, makarayi hazirliyorum… (bir dakika kadar surebilir)');

  const sonuc = await makara.makaraYap({ metin, botAdi });

  if (!sonuc.ok) {
    await bot.say(`⚠️ Makara olmadi: ${sonuc.hata}`);
    return;
  }

  if (!sonuc.cevap) {
    await bot.say(`🤷 \`${sonuc.kim}\` bos bir cevap dondu.`);
    return;
  }

  // Cevap, kaynagi belirtilmeden BOTUN KENDI SOZU gibi yazilir (kullanici
  // istegi): "MakaraMiyizAbi diyor ki" gibi bir baslik EKLENMEZ.
  await bot.say(sonuc.cevap);
}

// --- 6. islem: Liquibase ---------------------------------------------------

// Prod'a yazmadan once onizleme zorunlu. Onizleme sonucu odaya ozel saklanir;
// suresi dolarsa yeniden onizleme istenir (arada changelog degismis olabilir).
const PROD_ONAY_TTL_MS = 15 * 60 * 1000;
const prodOnaylar = new Map(); // roomId -> {zaman, kim, bekleyenAdet, sqlDosyasi, commit}

const LIQUIBASE_KULLANIM =
  '6. islem icin ikinci satira ortami yazmalisiniz.\n\n' +
  '```\n6\nstaging\n```\n' +
  '```\n6\nprod\n```\n' +
  '`prod` once yalnizca onizleme yapar; uygulamak icin `6` + `onayla`.';

// Webex mesaji sisirmesin diye liste kirpilir; tam liste run.cmd ciktisinda.
const CHANGESET_LISTE_SINIRI = 25;

function formatChangesetListesi(liste, adet, bosMesaji) {
  if (!adet) return bosMesaji;

  const satirlar = liste.slice(0, CHANGESET_LISTE_SINIRI).map((c, i) => `${i + 1}. \`${c}\``);
  if (adet > satirlar.length) {
    satirlar.push(`_… ve ${adet - satirlar.length} changeset daha._`);
  }
  return satirlar.join('\n');
}

function formatBekleyenler(bekleyenler, adet) {
  return formatChangesetListesi(bekleyenler, adet, '_Bekleyen changeset yok — veritabani guncel._');
}

function formatUygulananlar(uygulananlar, adet) {
  return formatChangesetListesi(uygulananlar, adet, '_Uygulanan changeset yok — veritabani zaten guncelmis._');
}

function senkronOzeti(senk) {
  const branchNotu =
    senk.oncekiBranch === 'prod'
      ? ''
      : ` (depo \`${senk.oncekiBranch}\` branch'inden \`prod\`'a alindi)`;
  const commitNotu =
    senk.yeniCommitSayisi > 0
      ? `${senk.yeniCommitSayisi} yeni commit cekildi → \`${senk.commit}\``
      : `zaten gunceldi → \`${senk.commit}\``;
  return `📥 Changelog'lar senkronlandi: ${commitNotu}${branchNotu}`;
}

async function handleOperationSix(bot, trigger, rest) {
  const arg = (rest || '').trim().toLowerCase();
  const kim = (trigger.person && trigger.person.displayName) || trigger.personEmail || 'bilinmiyor';

  if (!arg) {
    await bot.say(LIQUIBASE_KULLANIM);
    return;
  }

  if (arg === 'iptal') {
    const vardi = prodOnaylar.delete(bot.room.id);
    await bot.say(vardi ? '🚫 Bekleyen prod onayi iptal edildi.' : 'Bekleyen prod onayi yok.');
    return;
  }

  if (liquibaseMesgulMu()) {
    await bot.say('⏳ Su anda calisan bir liquibase islemi var. Bitmesini bekleyip tekrar deneyin.');
    return;
  }

  if (arg === 'onayla' || arg === 'onay') {
    await handleLiquibaseOnay(bot, kim);
    return;
  }

  if (arg !== 'staging' && arg !== 'prod') {
    await bot.say(`Bilinmeyen ortam: \`${arg}\`\n\n${LIQUIBASE_KULLANIM}`);
    return;
  }

  const prod = arg === 'prod';

  await bot.say(
    `🔄 \`${arg}\` icin changelog'lar \`prod\` branch'inden cekiliyor, ardindan liquibase ` +
      `${prod ? '**onizleme** modunda (veritabanina yazmadan)' : '**update** modunda'} calisacak. Birkac dakika surebilir…`
  );

  let senk;
  try {
    senk = await changeloglariSenkronla();
  } catch (err) {
    await bot.say(`❌ Changelog senkronizasyonu basarisiz:\n\`\`\`\n${err.message}\n\`\`\``);
    return;
  }

  let sonuc;
  try {
    sonuc = await liquibaseCalistir({ profil: arg, mod: prod ? 'preview' : 'update' });
  } catch (err) {
    await bot.say(`${senkronOzeti(senk)}\n\n❌ Liquibase calistirilamadi:\n\`\`\`\n${err.message}\n\`\`\``);
    return;
  }

  if (!sonuc.basarili) {
    prodOnaylar.delete(bot.room.id);
    await bot.say(
      `${senkronOzeti(senk)}\n\n❌ **Liquibase hata verdi** (\`${arg}\`, ${sonuc.sureSn} sn):\n` +
        `\`\`\`\n${(sonuc.hataMesaji || 'bilinmeyen hata').slice(0, 1200)}\n\`\`\``
    );
    return;
  }

  if (!prod) {
    await bot.say(
      `${senkronOzeti(senk)}\n\n` +
        `✅ **Liquibase calisti — staging** (${sonuc.sureSn} sn)\n` +
        `DB: \`${sonuc.url}\` · sema \`${sonuc.sema}\` · dropFirst \`${sonuc.dropFirst}\`\n\n` +
        `**Uygulanan changeset: ${sonuc.uygulanan}**\n\n` +
        formatUygulananlar(sonuc.uygulananlar, sonuc.uygulanan)
    );
    return;
  }

  // Prod: yalnizca onizleme yapildi, onay bekleniyor.
  if (!sonuc.bekleyenAdet) {
    prodOnaylar.delete(bot.room.id);
    await bot.say(
      `${senkronOzeti(senk)}\n\n` +
        `✅ **Prod zaten guncel** — uygulanacak changeset yok. Hicbir degisiklik yapilmadi.`
    );
    return;
  }

  prodOnaylar.set(bot.room.id, {
    zaman: Date.now(),
    kim,
    bekleyenAdet: sonuc.bekleyenAdet,
    sqlDosyasi: sonuc.sqlDosyasi,
    commit: senk.commit,
  });

  await bot.say(
    `${senkronOzeti(senk)}\n\n` +
      `🔍 **PROD ONIZLEME** — veritabanina **hicbir sey yazilmadi** (${sonuc.sureSn} sn)\n` +
      `DB: \`${sonuc.url}\` · sema \`${sonuc.sema}\` · dropFirst \`${sonuc.dropFirst}\`\n\n` +
      `**Uygulanacak changeset sayisi: ${sonuc.bekleyenAdet}**\n\n` +
      `${formatBekleyenler(sonuc.bekleyenler, sonuc.bekleyenAdet)}\n\n` +
      `Uretilecek SQL:\n\`\`\`\n${sonuc.sqlDosyasi}\n\`\`\`\n` +
      `⚠️ Uygulamak icin **${Math.round(PROD_ONAY_TTL_MS / 60000)} dakika** icinde:\n` +
      '```\n6\nonayla\n```\n' +
      'Vazgecmek icin: `6` + `iptal`'
  );
}

async function handleLiquibaseOnay(bot, kim) {
  const onay = prodOnaylar.get(bot.room.id);
  if (!onay) {
    await bot.say('Bekleyen bir prod onayi yok. Once `6` + `prod` ile onizleme alin.');
    return;
  }

  if (Date.now() - onay.zaman > PROD_ONAY_TTL_MS) {
    prodOnaylar.delete(bot.room.id);
    await bot.say(
      `⌛ Onizlemenin suresi doldu (${Math.round(PROD_ONAY_TTL_MS / 60000)} dk). ` +
        'Guvenlik icin `6` + `prod` ile yeniden onizleme alin.'
    );
    return;
  }

  // Onay tek kullanimlik: hata da olsa tekrar onizleme alinmali.
  prodOnaylar.delete(bot.room.id);

  await bot.say(
    `🚀 **PROD'A UYGULANIYOR** — ${onay.bekleyenAdet} changeset (onizleme: ${onay.kim}, onay: ${kim}). ` +
      'Changelog\'lar onizlemedeki hali ile kullanilir, yeniden cekilmez.'
  );

  let sonuc;
  try {
    sonuc = await liquibaseCalistir({ profil: 'prod', mod: 'update' });
  } catch (err) {
    await bot.say(`❌ Prod liquibase calistirilamadi:\n\`\`\`\n${err.message}\n\`\`\``);
    return;
  }

  if (!sonuc.basarili) {
    await bot.say(
      `❌ **PROD LIQUIBASE HATA VERDI** (${sonuc.sureSn} sn) — changelog \`${onay.commit}\`\n` +
        `\`\`\`\n${(sonuc.hataMesaji || 'bilinmeyen hata').slice(0, 1200)}\n\`\`\`\n` +
        (sonuc.basarisizChangeSet ? `💥 **Patlayan changeset:** \`${sonuc.basarisizChangeSet}\`\n` : '') +
        '\n⚠️ Liquibase her changeset\'i ayri uygular — **hatadan onceki changeset\'ler UYGULANDI:**\n\n' +
        `**${sonuc.uygulanan} changeset uygulandi**\n\n` +
        `${formatUygulananlar(sonuc.uygulananlar, sonuc.uygulanan)}\n\n` +
        'Guncel durumu gormek icin `6` + `prod` ile yeniden onizleme alin.'
    );
    return;
  }

  await bot.say(
    `✅ **PROD LIQUIBASE TAMAMLANDI** (${sonuc.sureSn} sn)\n` +
      `Changelog commit: \`${onay.commit}\`\n` +
      `DB: \`${sonuc.url}\` · sema \`${sonuc.sema}\` · dropFirst \`${sonuc.dropFirst}\`\n\n` +
      `**Uygulanan changeset: ${sonuc.uygulanan}** (onizlemede beklenen: ${onay.bekleyenAdet})\n\n` +
      formatUygulananlar(sonuc.uygulananlar, sonuc.uygulanan)
  );
}

/**
 * Botun etiketlendigi (mention) tum mesajlari yakalar.
 */
framework.hears(/.*/, async (bot, trigger) => {
  const message = trigger.message || {};
  const botName = (framework.person && framework.person.displayName) || '';

  // Kopru odasi (8. islem): buradaki mesajlar komut degil, karsi botun
  // cevabidir. Bekleyen bir makara varsa ona verilir; bu odaya ASLA yanit
  // yazilmaz (aksi halde iki bot birbirini tetikleyip dongu olusur).
  if (bot.room.id === makara.kopruOdaId()) {
    const govde = message.html
      ? htmlToText(message.html, botName)
      : (trigger.text || message.text || '');
    const verildi = makara.cevapGeldi({
      roomId: bot.room.id,
      personId: trigger.personId || message.personId,
      text: govde,
      created: message.created,
    });
    console.log(
      `Kopru odasi mesaji (${trigger.personEmail || '?'}) ${verildi ? 'bekleyen makaraya verildi' : 'yoksayildi'}.`
    );
    return;
  }

  // Env'de tanimli olmayan oda/DM — hic yanit verme.
  const perm = ROOM_PERMS.get(bot.room.id);
  if (!perm) {
    console.log(`Tanimsiz oda/DM mesaji yoksayildi: "${bot.room.title || '?'}" (roomId: ${bot.room.id})`);
    return;
  }

  // Mention'li mesajlarda `text` alaninda satir sonlari (shift+enter) kaybolur;
  // bu yuzden varsa `html` alanindan satir sonlarini koruyarak metin uretilir.
  // Grup odasinda mention metne bot adi olarak girer ("OSEM Bot islemler") — ayikla.
  const rawText = message.html
    ? htmlToText(message.html, botName)
    : (trigger.text || message.text || '');
  const text = stripBotMention(rawText, botName);
  const { command, rest } = parseInput(text);

  const cmdLower = command.toLowerCase();

  if (cmdLower === 'islemler' || cmdLower === 'help' || cmdLower === 'yardim' || cmdLower === '') {
    await bot.say(buildMenu(perm));
    return;
  }

  if (!OPERATIONS.some((op) => op.cmd === command)) {
    await bot.say(`Anlasilmayan komut: \`${command}\`\n\n${buildMenu(perm)}`);
    return;
  }

  if (!isAllowed(perm, command)) {
    await bot.say(`⛔ \`${command}\` islemi bu grupta yetkili degil.\n\n${buildMenu(perm)}`);
    return;
  }

  switch (command) {
    case '1':
      await handleOperationOne(bot, rest);
      break;
    case '2':
      await handleOperationTwo(bot, rest);
      break;
    case '3':
      await handleOperationThree(bot, rest);
      break;
    case '4':
      await handleOperationFour(bot, trigger, rest);
      break;
    case '5':
      await handleOperationFive(bot, trigger, rest);
      break;
    case '6':
      await handleOperationSix(bot, trigger, rest);
      break;
    case '7':
      await handleOperationSeven(bot, rest);
      break;
    case '8':
      await handleOperationEight(bot, rest);
      break;
    case '9':
      await handleOperationNine(bot, trigger, rest);
      break;
  }
});

framework.on('spawn', (bot, id, addedBy) => {
  if (addedBy && ROOM_PERMS.has(bot.room.id)) {
    bot.say('Merhaba! OSEM Islem Botu hazir. Islemleri gormek icin beni etiketleyip `islemler` yazin.');
  }
});
