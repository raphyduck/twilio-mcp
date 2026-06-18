// Express webhook server. Bound to 127.0.0.1 (behind Nginx reverse proxy).
// All logs go to stderr — stdout is reserved for the MCP protocol.

import express from 'express';
import { upsertCall, removeCall } from './callStore.js';
import { upsertSms } from './smsStore.js';

const log = (...args) => console.error('[webhook]', ...args);

// Remove the call from memory 5 minutes after it ends.
const REMOVE_DELAY_MS = 5 * 60 * 1000;

const HOLD_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Pause length="300"/></Response>`;

const ANSWER_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="fr-FR">Un instant, je vous réponds.</Say>
  <Pause length="300"/>
</Response>`;

export function createWebhookApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  // Inbound calls — auto-answered with a hold TwiML.
  app.post('/webhook/voice', (req, res) => {
    const { CallSid, From, To } = req.body;
    log('inbound call', CallSid, From, '->', To);
    upsertCall(CallSid, {
      status: 'ringing',
      direction: 'inbound',
      from: From,
      to: To,
      startedAt: new Date().toISOString(),
    });
    res.set('Content-Type', 'text/xml');
    res.send(ANSWER_TWIML);
  });

  // Call lifecycle status callbacks.
  app.post('/webhook/status', (req, res) => {
    const { CallSid, CallStatus, Duration } = req.body;
    log('status', CallSid, CallStatus);

    switch (CallStatus) {
      case 'ringing':
        upsertCall(CallSid, { status: 'ringing' });
        break;
      case 'in-progress':
        upsertCall(CallSid, {
          status: 'active',
          answeredAt: new Date().toISOString(),
        });
        break;
      case 'completed':
        upsertCall(CallSid, {
          status: 'ended',
          hungUpAt: new Date().toISOString(),
          duration: Duration,
        });
        setTimeout(() => removeCall(CallSid), REMOVE_DELAY_MS).unref?.();
        break;
      case 'busy':
      case 'failed':
      case 'no-answer':
        upsertCall(CallSid, { status: 'ended', reason: CallStatus });
        break;
      default:
        break;
    }

    res.status(200).end();
  });

  // Inbound SMS.
  app.post('/webhook/sms', (req, res) => {
    const { MessageSid, From, To, Body } = req.body;
    log('inbound sms', MessageSid, From, '->', To);
    upsertSms(MessageSid, {
      direction: 'inbound',
      from: From,
      to: To,
      body: Body,
      status: 'received',
      receivedAt: new Date().toISOString(),
      read: false,
    });
    res.status(200).end();
  });

  // Static hold TwiML for outbound calls.
  app.get('/webhook/twiml/hold', (req, res) => {
    res.set('Content-Type', 'text/xml');
    res.send(HOLD_TWIML);
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  return app;
}

export function startWebhook() {
  const port = Number(process.env.WEBHOOK_PORT) || 3001;
  const app = createWebhookApp();
  const server = app.listen(port, process.env.WEBHOOK_HOST || '127.0.0.1', () => {
    log(`listening on 127.0.0.1:${port}`);
  });
  return server;
}
