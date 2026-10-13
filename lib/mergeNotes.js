'use strict';

// Merge notlari deposu (4. islem).
// Notlar JSON dosyada tutulur ki pm2 restart'inda (max_memory_restart) kaybolmasin.
// Tek ortak havuz: hangi gruptan birakilirsa birakilsin ayni listeye girer,
// 3. islem calistirildiginda gosterilip temizlenir.

const fs = require('fs');
const path = require('path');

const NOTES_FILE =
  process.env.MERGE_NOTES_FILE || path.join(__dirname, '..', 'data', 'mergeNotes.json');

/**
 * Dosyayi okur. Dosya yoksa/bozuksa bot patlamasin diye bos liste doner.
 * @returns {{counter: number, notes: Array}}
 */
function readStore() {
  try {
    const raw = fs.readFileSync(NOTES_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      counter: Number(data.counter) || 0,
      notes: Array.isArray(data.notes) ? data.notes : [],
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Merge notlari okunamadi (${NOTES_FILE}): ${err.message}`);
    }
    return { counter: 0, notes: [] };
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(NOTES_FILE), { recursive: true });
  fs.writeFileSync(NOTES_FILE, JSON.stringify(store, null, 2), 'utf8');
}

/**
 * Yeni not ekler.
 * @param {{author: string, text: string}} param0
 * @returns {{id: number, author: string, text: string, createdAt: string}}
 */
function addNote({ author, text }) {
  const store = readStore();
  store.counter += 1;
  const note = {
    id: store.counter,
    author: (author || 'bilinmiyor').trim(),
    text: (text || '').trim(),
    createdAt: new Date().toISOString(),
  };
  store.notes.push(note);
  writeStore(store);
  return note;
}

/**
 * Bekleyen notlari doner (eklenme sirasinda).
 */
function listNotes() {
  return readStore().notes;
}

/**
 * Tum notlari siler, silinen adedi doner. Sayac korunur (id'ler tekrar etmesin).
 */
function clearNotes() {
  const store = readStore();
  const count = store.notes.length;
  if (count > 0) {
    store.notes = [];
    writeStore(store);
  }
  return count;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Notlari Webex markdown mesajina cevirir (saf fonksiyon).
 */
function formatNotes(notes) {
  const lines = notes.map((n, i) => {
    const tarih = formatDate(n.createdAt);
    return `${i + 1}. **${n.author}** — ${n.text}${tarih ? ` _(${tarih})_` : ''}`;
  });

  return (
    `⚠️ **DIKKAT — bu merge icin birakilan notlar (${notes.length}):**\n\n` +
    lines.join('\n') +
    '\n\n_Notlar gosterildi ve listeden temizlendi._'
  );
}

module.exports = { addNote, listNotes, clearNotes, formatNotes, NOTES_FILE };
