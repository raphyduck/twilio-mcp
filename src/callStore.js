// In-memory store for call state. Key: callSid (string).
// No database — state lives only for the lifetime of the process.

const calls = new Map();

/**
 * Insert or merge call data. Always refreshes updatedAt.
 * @param {string} callSid
 * @param {object} data
 * @returns {object} the stored record
 */
export function upsertCall(callSid, data = {}) {
  const existing = calls.get(callSid) || { call_sid: callSid };
  const merged = {
    ...existing,
    ...data,
    call_sid: callSid,
    updatedAt: new Date().toISOString(),
  };
  calls.set(callSid, merged);
  return merged;
}

export function getCall(callSid) {
  return calls.get(callSid) || null;
}

export function removeCall(callSid) {
  return calls.delete(callSid);
}

export function getAllCalls() {
  return [...calls.values()];
}

// Inbound calls still ringing (waiting to be handled).
export function getIncomingCalls() {
  return [...calls.values()].filter(
    (c) => c.direction === 'inbound' && c.status === 'ringing',
  );
}

// Calls currently connected.
export function getActiveCalls() {
  return [...calls.values()].filter((c) => c.status === 'active');
}
