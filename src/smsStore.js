// In-memory store for SMS state. Key: messageSid (string).
//
// Record shape:
// {
//   message_sid,
//   direction,   // 'inbound' | 'outbound'
//   from,
//   to,
//   body,
//   status,      // 'received' | 'sent' | 'delivered' | 'failed'
//   receivedAt,  // inbound
//   sentAt,      // outbound
//   read,        // boolean (inbound)
//   updatedAt,
// }

const messages = new Map();

/**
 * Insert or merge SMS data. Always refreshes updatedAt.
 * @param {string} messageSid
 * @param {object} data
 * @returns {object} the stored record
 */
export function upsertSms(messageSid, data = {}) {
  const existing = messages.get(messageSid) || { message_sid: messageSid };
  const merged = {
    ...existing,
    ...data,
    message_sid: messageSid,
    updatedAt: new Date().toISOString(),
  };
  messages.set(messageSid, merged);
  return merged;
}

export function getSms(messageSid) {
  return messages.get(messageSid) || null;
}

export function getAllSms() {
  return [...messages.values()];
}

export function getInboundSms() {
  return [...messages.values()].filter((m) => m.direction === 'inbound');
}

export function getUnreadSms() {
  return [...messages.values()].filter(
    (m) => m.direction === 'inbound' && m.read === false,
  );
}

export function markAsRead(messageSid) {
  const msg = messages.get(messageSid);
  if (!msg) return null;
  msg.read = true;
  msg.updatedAt = new Date().toISOString();
  messages.set(messageSid, msg);
  return msg;
}
