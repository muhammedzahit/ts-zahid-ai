'use strict';

const path = require('path');
const fs = require('fs');
const { Client } = require('pg');
const ExcelJS = require('exceljs');

/**
 * Sorgunun yalnizca SELECT (veya WITH ... SELECT) olup olmadigini kontrol eder.
 * Birden fazla ifade / tehlikeli anahtar kelime iceriyorsa reddeder.
 */
function validateSelectQuery(rawQuery) {
  if (!rawQuery || !rawQuery.trim()) {
    return { ok: false, reason: 'Bos sorgu gonderildi.' };
  }

  // Sondaki ; kaldirilir, yorumlar temizlenir.
  let q = rawQuery.trim();
  const withoutTrailingSemicolon = q.replace(/;\s*$/, '');

  // Coklu ifade kontrolu (icerde ; varsa).
  if (withoutTrailingSemicolon.includes(';')) {
    return { ok: false, reason: 'Birden fazla SQL ifadesi calistirilamaz. Yalnizca tek bir SELECT sorgusu girin.' };
  }

  const lower = withoutTrailingSemicolon.toLowerCase();

  const startsOk = lower.startsWith('select') || lower.startsWith('with');
  if (!startsOk) {
    return { ok: false, reason: 'Yalnizca SELECT sorgulari calistirilabilir.' };
  }

  // Anahtar kelime taramasi string literal / tirnak icindeki degerlerde yanlis
  // alarm vermesin diye once bunlar temizlenir (ör. WHERE ad = 'update me').
  const stripped = lower
    .replace(/'(?:[^']|'')*'/g, "''") // tek tirnakli string literaller
    .replace(/"(?:[^"]|"")*"/g, '""'); // cift tirnakli tanimlayicilar

  // Ek guvenlik: yazma/DDL anahtar kelimeleri kelime siniriyla aranir.
  const forbidden = ['insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate', 'grant', 'revoke', 'merge', 'call', 'do', 'copy'];
  for (const word of forbidden) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    if (re.test(stripped)) {
      return { ok: false, reason: `Sorgu izin verilmeyen bir anahtar kelime iceriyor: "${word}". Yalnizca SELECT calistirilabilir.` };
    }
  }

  return { ok: true, query: withoutTrailingSemicolon };
}

/**
 * SELECT sorgusunu transaction icinde calistirir ve daima ROLLBACK yapar.
 */
async function runSelectInTransaction(query) {
  const client = new Client({
    host: process.env.PROD_POSTGRES_IP,
    port: parseInt(process.env.PROD_POSTGRES_PORT, 10),
    user: process.env.PROD_POSTGRES_USERNAME,
    password: process.env.PROD_PORTGRES_PASSWORD,
    database: process.env.PROD_POSTGRES_DB,
  });

  await client.connect();
  try {
    // Sorgudaki nitelenmemis tablo adlari dogru semada cozulsun diye search_path ayarlanir.
    const schema = process.env.PROD_POSTGRES_SCHEMA;
    if (schema) {
      const quoted = '"' + schema.replace(/"/g, '""') + '"';
      await client.query(`SET search_path TO ${quoted}`);
    }

    await client.query('BEGIN');
    const result = await client.query(query);
    // Update olma ihtimaline karsi her durumda geri al.
    await client.query('ROLLBACK');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* yok say */
    }
    throw err;
  } finally {
    await client.end();
  }
}

/**
 * Sorgu sonucunu SHARED_FOLDER icine timestamp isimli bir excel dosyasi olarak yazar.
 * Birlesik dosya yolunu doner.
 */
async function exportToExcel(result) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sonuc');

  const fields = (result.fields || []).map((f) => f.name);
  if (fields.length > 0) {
    sheet.columns = fields.map((name) => ({ header: name, key: name, width: 24 }));
    for (const row of result.rows) {
      // Obje/array degerleri excel'e string olarak yazilir.
      const clean = {};
      for (const key of fields) {
        const val = row[key];
        clean[key] = val !== null && typeof val === 'object' ? JSON.stringify(val) : val;
      }
      sheet.addRow(clean);
    }
  } else {
    sheet.addRow(['Sorgu sonuc dondurmedi.']);
  }

  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '');
  const fileName = `query_result_${ts}.xlsx`;

  const sharedFolder = process.env.SHARED_FOLDER;
  const fullPath = path.join(sharedFolder, fileName);

  // SHARED_FOLDER erisilemezse hata firlar; cagiran taraf yakalar.
  await workbook.xlsx.writeFile(fullPath);

  return { fileName, fullPath };
}

/**
 * 2. islem: SELECT dogrula -> transaction/rollback ile calistir -> excel uret.
 */
async function handleSelectQuery(rawQuery) {
  const validation = validateSelectQuery(rawQuery);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason };
  }

  const result = await runSelectInTransaction(validation.query);
  const { fileName, fullPath } = await exportToExcel(result);

  return { ok: true, rowCount: result.rowCount, fileName, fullPath };
}

module.exports = { handleSelectQuery, validateSelectQuery };
