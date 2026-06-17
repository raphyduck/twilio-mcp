// Thin wrapper around the Twilio REST API (voice + SMS).
// Uses native fetch, HTTP Basic auth, and form-urlencoded bodies.
// No Twilio SDK.

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const WEBHOOK_BASE = process.env.TWILIO_WEBHOOK_BASE;

const BASE_URL = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}`;
const auth = 'Basic ' + btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`);

/**
 * Internal request helper.
 * @param {string} method  HTTP method
 * @param {string} path    path appended to BASE_URL (e.g. '/Calls')
 * @param {object} [params] form/query params
 */
async function request(method, path, params = {}) {
  const url = new URL(BASE_URL + path);
  const opts = {
    method,
    headers: { Authorization: auth },
  };

  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  } else {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) form.set(k, v);
    }
    opts.body = form;
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const message = data?.message || text || res.statusText;
    throw new Error(`Twilio API ${res.status}: ${message}`);
  }

  return data;
}

// ---------- Voice ----------

export async function createCall({ to, from }) {
  return request('POST', '/Calls.json', {
    To: to,
    From: from || FROM_NUMBER,
    Url: `${WEBHOOK_BASE}/twiml/hold`,
    StatusCallback: `${WEBHOOK_BASE}/webhook/status`,
    StatusCallbackMethod: 'POST',
    StatusCallbackEvent: 'initiated ringing answered completed',
  });
}

export async function hangupCall(callSid) {
  return request('POST', `/Calls/${callSid}.json`, {
    Status: 'completed',
  });
}

export async function speakOnCall(
  callSid,
  text,
  { language = 'fr-FR', voice = 'alice' } = {},
) {
  const twiml = `<Response><Say voice="${voice}" language="${language}">${escapeXml(
    text,
  )}</Say><Pause length="60"/></Response>`;
  return request('POST', `/Calls/${callSid}.json`, { Twiml: twiml });
}

export async function sendDtmf(callSid, digits) {
  const twiml = `<Response><Play digits="${digits}"/></Response>`;
  return request('POST', `/Calls/${callSid}.json`, { Twiml: twiml });
}

export async function transferCall(callSid, to) {
  const twiml = `<Response><Dial>${escapeXml(to)}</Dial></Response>`;
  return request('POST', `/Calls/${callSid}.json`, { Twiml: twiml });
}

export async function getCallFromApi(callSid) {
  return request('GET', `/Calls/${callSid}.json`);
}

// ---------- SMS ----------

export async function sendSms({ to, body, from }) {
  return request('POST', '/Messages.json', {
    To: to,
    From: from || FROM_NUMBER,
    Body: body,
  });
}

export async function listSms({ limit = 20, to, from } = {}) {
  const data = await request('GET', '/Messages.json', {
    PageSize: limit,
    To: to,
    From: from,
  });
  return data.messages || [];
}

export async function getSms(messageSid) {
  return request('GET', `/Messages/${messageSid}.json`);
}

// Escape characters that would break XML. URLSearchParams handles transport
// encoding, but the content itself still needs to be valid XML.
function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
