'use strict';

// Bellek ici ticket deposu. Bot yeniden baslarsa bekleyen talepler silinir
// (kalicilik gerekirse JSON dosyaya yazilabilir).
let counter = 0;
const tickets = new Map();

/**
 * Yeni bir talep (ticket) olusturur ve artan tam sayi id verir.
 * data: { type: '1'|'2', payload, requesterName, requesterEmail, roomId }
 */
function createTicket(data) {
  counter += 1;
  const ticket = {
    id: counter,
    status: 'pending', // pending | approved | rejected
    createdAt: new Date(),
    resolvedAt: null,
    resolvedBy: null,
    ...data,
  };
  tickets.set(counter, ticket);
  return ticket;
}

function getTicket(id) {
  return tickets.get(Number(id));
}

/**
 * Ticket durumunu gunceller (approved/rejected) ve onaylayani kaydeder.
 */
function resolveTicket(id, status, resolvedBy) {
  const t = tickets.get(Number(id));
  if (t) {
    t.status = status;
    t.resolvedAt = new Date();
    t.resolvedBy = resolvedBy || null;
  }
  return t;
}

module.exports = { createTicket, getTicket, resolveTicket };
