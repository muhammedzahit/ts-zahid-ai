'use strict';

// 5. islem (kod incelemesi) icin STAGING veritabanina SALT-OKUMA erisimi.
//
// Kimlik bilgisi YALNIZCA liquibase-spring/.env'deki STAGING_DB_* anahtarlarindan
// okunur; PROD_DB_* anahtarlarina hic bakilmaz.
//
// Salt-okuma katmanlari:
//   1. validateSelectQuery (lib/dbQuery.js): tek ifade, SELECT/WITH, yazma/DDL yasak
//   2. Ek yasakli fonksiyonlar (dblink, pg_terminate_backend, set_config, ...)
//   3. Baglanti default_transaction_read_only=on ile acilir, sorgu
//      BEGIN TRANSACTION READ ONLY icinde calisir ve her durumda ROLLBACK edilir —
//      yazma girisimini Postgres'in kendisi reddeder (nextval dahil).
//   4. statement_timeout 30 sn, lock_timeout 5 sn, en fazla 50 satir.
// En saglam ek katman: .env'deki STAGING kullanicisinin DB'de yalnizca SELECT
// yetkisi olmasi.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { validateSelectQuery } = require('./dbQuery');
const { PROJECT_DIR } = require('./liquibaseRun');

const MAX_SATIR = 50;
const HUCRE_MAKS = 500;

// Transaction'in disina cikabilen ya da sunucu durumunu degistiren fonksiyonlar.
const YASAKLI_FONKSIYONLAR = [
  'dblink', 'dblink_exec', 'dblink_connect', 'pg_terminate_backend', 'pg_cancel_backend',
  'pg_reload_conf', 'pg_rotate_logfile', 'set_config', 'lo_import', 'lo_export', 'lo_unlink',
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file', 'pg_advisory_lock',
  'pg_advisory_xact_lock', 'pg_sleep', 'pg_logical_emit_message', 'pg_notify', 'nextval', 'setval',
];

/**
 * KEY=VALUE .env dosyasindan YALNIZCA STAGING_DB_* anahtarlarini okur
 * (run.cmd ile ayni kurallar: # yorum, tirnak yok, ilk = ayirir).
 */
function stagingEnvOku(dosyaYolu) {
  if (!fs.existsSync(dosyaYolu)) return {};
  const sonuc = {};
  for (const satir of fs.readFileSync(dosyaYolu, 'utf8').split(/\r?\n/)) {
    if (!satir.trim() || satir.trimStart().startsWith('#')) continue;
    const i = satir.indexOf('=');
    if (i < 0) continue;
    const anahtar = satir.slice(0, i).trim();
    if (!anahtar.startsWith('STAGING_DB_')) continue;
    sonuc[anahtar] = satir.slice(i + 1).trim();
  }
  return sonuc;
}

/** jdbc:postgresql://host:port/db?currentSchema=x → {host, port, database, schema} */
function jdbcCoz(url) {
  const m = (url || '').trim().match(/^jdbc:postgresql:\/\/([^/:?]+)(?::(\d+))?\/([^?]+)(?:\?(.*))?$/i);
  if (!m) return null;
  const parametreler = new URLSearchParams(m[4] || '');
  return {
    host: m[1],
    port: m[2] ? Number(m[2]) : 5432,
    database: decodeURIComponent(m[3]),
    schema: parametreler.get('currentSchema') || '',
  };
}

function kapaliMi(deger) {
  return ['kapali', 'kapalı', '0', 'false', 'hayir', 'hayır', 'off'].includes(
    String(deger || '').trim().toLowerCase()
  );
}

/**
 * STAGING baglanti ayarlari; erisim kapaliysa ya da bilgiler eksikse null.
 * @returns {{host, port, database, user, password, schema} | null}
 */
function stagingAyarlari(env = process.env, envDosyasi = path.join(PROJECT_DIR, '.env')) {
  if (kapaliMi(env.KOD_REVIEW_STAGING)) return null;
  const s = stagingEnvOku(envDosyasi);
  const jdbc = jdbcCoz(s.STAGING_DB_URL);
  if (!jdbc || !s.STAGING_DB_USERNAME) return null;
  return {
    host: jdbc.host,
    port: jdbc.port,
    database: jdbc.database,
    user: s.STAGING_DB_USERNAME,
    password: s.STAGING_DB_PASSWORD || '',
    schema: s.STAGING_DB_SCHEMA || jdbc.schema || '',
  };
}

/** validateSelectQuery + yasakli fonksiyon kontrolu. */
function sorguDogrula(sql) {
  const v = validateSelectQuery(sql);
  if (!v.ok) return v;
  const temiz = v.query
    .toLowerCase()
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const f of YASAKLI_FONKSIYONLAR) {
    if (new RegExp(`\\b${f}\\b`).test(temiz)) {
      return { ok: false, reason: `"${f}" kullanimi yasak (staging yalnizca okunabilir).` };
    }
  }
  if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/.test(temiz)) {
    return { ok: false, reason: 'Kilit alan SELECT ... FOR UPDATE/SHARE yasak.' };
  }
  return v;
}

function hucre(deger) {
  if (deger === null || deger === undefined) return 'NULL';
  let s;
  if (deger instanceof Date) s = deger.toISOString();
  else if (Buffer.isBuffer(deger)) s = `<${deger.length} bayt>`;
  else if (typeof deger === 'object') s = JSON.stringify(deger);
  else s = String(deger);
  s = s.replace(/\r?\n/g, '\\n').replace(/\|/g, '\\|');
  return s.length > HUCRE_MAKS ? `${s.slice(0, HUCRE_MAKS)}…` : s;
}

/**
 * Sorgu sonucunu modele verilecek kisa metin tabloya cevirir.
 * Satirlar dizi (rowMode: 'array') olarak beklenir; ayni adli kolonlar ezilmesin.
 */
function sonucuBicimle(sonuc, maxSatir = MAX_SATIR) {
  const kolonlar = (sonuc.fields || []).map((f) => f.name);
  const satirlar = sonuc.rows || [];
  const gosterilen = satirlar.slice(0, maxSatir);
  const govde = gosterilen.map((r) =>
    (Array.isArray(r) ? r : kolonlar.map((k) => r[k])).map(hucre).join(' | ')
  );
  const ek = satirlar.length > maxSatir
    ? `(ilk ${maxSatir} satir gosterildi; daha fazlasi var — WHERE/LIMIT ile daraltin)`
    : `(${satirlar.length} satir)`;
  return [`Kolonlar: ${kolonlar.join(' | ')}`, ...govde, ek].join('\n');
}

/**
 * STAGING'de salt-okunur SELECT calistirir, sonucu metin olarak dondurur.
 * Dogrulama hatasinda ya da DB hatasinda Error firlatir.
 */
async function stagingSorgu(sql, ayar, maxSatir = MAX_SATIR) {
  if (!ayar) throw new Error('STAGING erisimi tanimli degil.');
  const dogrulama = sorguDogrula(sql);
  if (!dogrulama.ok) throw new Error(dogrulama.reason);

  const client = new Client({
    host: ayar.host,
    port: ayar.port,
    database: ayar.database,
    user: ayar.user,
    password: ayar.password,
    // Oturumdaki her transaction varsayilan olarak salt-okunur.
    options: '-c default_transaction_read_only=on',
    connectionTimeoutMillis: 15000,
    query_timeout: 45000,
  });

  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    if (ayar.schema) {
      await client.query(`SET LOCAL search_path TO "${ayar.schema.replace(/"/g, '""')}"`);
    }
    // Satir siniri sorgunun disindan uygulanir; buyuk sonuclar bellege cekilmez.
    const sonuc = await client.query({
      text: `SELECT * FROM (\n${dogrulama.query}\n) AS _staging_sorgu LIMIT ${maxSatir + 1}`,
      rowMode: 'array',
    });
    return sonucuBicimle(sonuc, maxSatir);
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* yok say */
    }
    await client.end();
  }
}

module.exports = {
  stagingAyarlari,
  stagingSorgu,
  stagingEnvOku,
  jdbcCoz,
  sorguDogrula,
  sonucuBicimle,
  kapaliMi,
  MAX_SATIR,
};
