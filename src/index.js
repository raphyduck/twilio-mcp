// MCP server (stdio) + webhook startup.
//
// stdout is reserved for the MCP protocol — every log goes to stderr.

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { startWebhook } from './webhook.js';
import * as twilio from './twilioApi.js';
import {
  getCall,
  getAllCalls,
  getIncomingCalls,
  getActiveCalls,
} from './callStore.js';
import {
  upsertSms,
  getSms as getSmsFromStore,
  getInboundSms,
  getUnreadSms,
  markAsRead,
} from './smsStore.js';

const log = (...args) => console.error('[mcp]', ...args);

// Wrap a payload as MCP text content (JSON-stringified for structured data).
function ok(payload) {
  const text =
    typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

function fail(err) {
  log('tool error:', err?.message || err);
  return {
    content: [{ type: 'text', text: `Error: ${err?.message || String(err)}` }],
    isError: true,
  };
}

const server = new McpServer({
  name: 'twilio-mcp',
  version: '1.0.0',
});

// ---------- Voice tools ----------

server.tool(
  'make_call',
  'Place an outbound call. Returns the call_sid.',
  {
    to: z.string().describe('Destination phone number in E.164 format'),
    from: z.string().optional().describe('Caller ID (defaults to TWILIO_FROM_NUMBER)'),
  },
  async ({ to, from }) => {
    try {
      const call = await twilio.createCall({ to, from });
      return ok({ call_sid: call.sid, status: call.status, to: call.to });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  'list_incoming_calls',
  'List inbound calls currently ringing (waiting to be handled).',
  {},
  async () => ok(getIncomingCalls()),
);

server.tool(
  'list_active_calls',
  'List currently active (connected) calls.',
  {},
  async () => ok(getActiveCalls()),
);

server.tool(
  'list_all_calls',
  'List all calls known to the in-memory store.',
  {},
  async () => ok(getAllCalls()),
);

server.tool(
  'get_call_status',
  'Get the local (in-memory) state of a call.',
  { call_sid: z.string() },
  async ({ call_sid }) => {
    const call = getCall(call_sid);
    if (!call) return fail(new Error(`Unknown call_sid: ${call_sid}`));
    return ok(call);
  },
);

server.tool(
  'hangup_call',
  'Hang up a call.',
  { call_sid: z.string() },
  async ({ call_sid }) => {
    try {
      await twilio.hangupCall(call_sid);
      return ok({ call_sid, status: 'completed' });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  'speak_on_call',
  'Speak text on a call via TwiML redirect (text-to-speech).',
  {
    call_sid: z.string(),
    text: z.string(),
    language: z.string().optional(),
    voice: z.string().optional(),
  },
  async ({ call_sid, text, language, voice }) => {
    try {
      await twilio.speakOnCall(call_sid, text, { language, voice });
      return ok({ call_sid, spoke: text });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  'send_dtmf',
  'Send DTMF tones on a call.',
  { call_sid: z.string(), digits: z.string() },
  async ({ call_sid, digits }) => {
    try {
      await twilio.sendDtmf(call_sid, digits);
      return ok({ call_sid, digits });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  'transfer_call',
  'Transfer a call to another number.',
  { call_sid: z.string(), to: z.string() },
  async ({ call_sid, to }) => {
    try {
      await twilio.transferCall(call_sid, to);
      return ok({ call_sid, transferred_to: to });
    } catch (err) {
      return fail(err);
    }
  },
);

// ---------- SMS tools ----------

server.tool(
  'send_sms',
  'Send an SMS. Returns the message_sid.',
  {
    to: z.string(),
    body: z.string(),
    from: z.string().optional(),
  },
  async ({ to, body, from }) => {
    try {
      const msg = await twilio.sendSms({ to, body, from });
      upsertSms(msg.sid, {
        direction: 'outbound',
        from: msg.from,
        to: msg.to,
        body,
        status: msg.status || 'sent',
        sentAt: new Date().toISOString(),
      });
      return ok({ message_sid: msg.sid, status: msg.status });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  'list_inbound_sms',
  'List all received SMS held in memory.',
  {},
  async () => ok(getInboundSms()),
);

server.tool(
  'list_unread_sms',
  'List received SMS that have not been marked as read.',
  {},
  async () => ok(getUnreadSms()),
);

server.tool(
  'get_sms',
  'Get the details of a stored SMS.',
  { message_sid: z.string() },
  async ({ message_sid }) => {
    const msg = getSmsFromStore(message_sid);
    if (!msg) return fail(new Error(`Unknown message_sid: ${message_sid}`));
    return ok(msg);
  },
);

server.tool(
  'mark_sms_read',
  'Mark a received SMS as read.',
  { message_sid: z.string() },
  async ({ message_sid }) => {
    const msg = markAsRead(message_sid);
    if (!msg) return fail(new Error(`Unknown message_sid: ${message_sid}`));
    return ok(msg);
  },
);

server.tool(
  'list_recent_sms',
  'List recent SMS (inbound + outbound) directly from the Twilio API.',
  { limit: z.number().int().positive().optional() },
  async ({ limit }) => {
    try {
      const messages = await twilio.listSms({ limit: limit ?? 20 });
      const simplified = messages.map((m) => ({
        message_sid: m.sid,
        direction: m.direction,
        from: m.from,
        to: m.to,
        body: m.body,
        status: m.status,
        date_sent: m.date_sent,
      }));
      return ok(simplified);
    } catch (err) {
      return fail(err);
    }
  },
);

// ---------- Startup ----------

async function main() {
  // Start the webhook server first (call/SMS lifecycle events).
  if (!process.env.WEBHOOK_DISABLED) startWebhook();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('twilio-mcp server connected over stdio');
}

main().catch((err) => {
  log('fatal:', err);
  process.exit(1);
});
