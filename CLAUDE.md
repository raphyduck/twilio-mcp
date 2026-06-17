# CLAUDE.md - twilio-mcp

## Contexte

Serveur MCP (Model Context Protocol) en Node.js pour passer et recevoir des appels
téléphoniques ET des SMS via l'API Twilio. Déployé en Docker sur Arch Linux avec Nginx
en reverse proxy.

## Stack

- Node.js 22 Alpine
- @modelcontextprotocol/sdk (dernière version stable)
- express
- dotenv
- ESM natif (type: module), pas de TypeScript

## Structure à produire

```
twilio-mcp/
├── CLAUDE.md
├── Dockerfile
├── docker-compose.yml
├── package.json
├── .env.example
└── src/
    ├── index.js        ← MCP stdio + démarrage webhook
    ├── callStore.js    ← état en mémoire des appels
    ├── smsStore.js     ← état en mémoire des SMS
    ├── twilioApi.js    ← wrapper REST Twilio (voix + SMS)
    └── webhook.js      ← Express sur 127.0.0.1:3001
```

## Variables d'environnement (.env.example)

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_FROM_NUMBER=+1xxxxxxxxxx
TWILIO_WEBHOOK_BASE=https://ton-domaine.tld/twilio
WEBHOOK_PORT=3001
```

## Différence fondamentale avec Telnyx

Twilio est **webhook-driven** : le contrôle d'appel se fait via TwiML (XML) renvoyé
dans la réponse HTTP au webhook, pas via des actions REST séparées.

Pour modifier un appel en cours (parler, raccrocher), on POSTe sur l'API REST
qui redirige l'appel vers un nouveau TwiML.

---

## twilioApi.js

Base URL : `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}`
Auth : HTTP Basic — `btoa(ACCOUNT_SID + ':' + AUTH_TOKEN)`
Corps des requêtes : **application/x-www-form-urlencoded** (pas JSON).

```js
const auth = 'Basic ' + btoa(`${sid}:${token}`);
```

Helper interne `request(method, path, params)` qui encode params en URLSearchParams.

### Fonctions Voix

**`createCall({ to, from? })`**
```
POST /Calls
To, From, Url=${TWILIO_WEBHOOK_BASE}/twiml/hold,
StatusCallback=${TWILIO_WEBHOOK_BASE}/webhook/status,
StatusCallbackMethod=POST,
StatusCallbackEvent=initiated ringing answered completed
```

**`hangupCall(callSid)`**
```
POST /Calls/${callSid}   →   Status=completed
```

**`speakOnCall(callSid, text, { language='fr-FR', voice='alice' })`**
```
POST /Calls/${callSid}
Twiml=<Response><Say voice="alice" language="fr-FR">${text}</Say><Pause length="60"/></Response>
```
Bien échapper le XML dans le body form-urlencoded via URLSearchParams (gère l'encoding automatiquement).

**`sendDtmf(callSid, digits)`**
```
POST /Calls/${callSid}
Twiml=<Response><Play digits="${digits}"/></Response>
```

**`transferCall(callSid, to)`**
```
POST /Calls/${callSid}
Twiml=<Response><Dial>${to}</Dial></Response>
```

**`getCallFromApi(callSid)`**
```
GET /Calls/${callSid}
```

### Fonctions SMS

**`sendSms({ to, body, from? })`**
```
POST /Messages
To, From, Body
```
Retourne le MessageSid.

**`listSms({ limit=20, to?, from? })`**
```
GET /Messages?PageSize=${limit}&To=${to}&From=${from}
```

**`getSms(messageSid)`**
```
GET /Messages/${messageSid}
```

---

## callStore.js

Map en mémoire. Clé : `callSid` (string).

Fonctions à exporter :
- `upsertCall(callSid, data)` — merge avec existant + updatedAt
- `getCall(callSid)`
- `removeCall(callSid)` — utilisé dans setTimeout 5min post-completed
- `getAllCalls()`
- `getIncomingCalls()` — direction=inbound AND status=ringing
- `getActiveCalls()` — status=active

---

## smsStore.js

Map en mémoire. Clé : `messageSid` (string).

Structure d'un SMS :
```js
{
  message_sid,
  direction,   // 'inbound' | 'outbound'
  from,
  to,
  body,
  status,      // 'received' | 'sent' | 'delivered' | 'failed'
  receivedAt,  // pour inbound
  sentAt,      // pour outbound
  updatedAt,
}
```

Fonctions à exporter :
- `upsertSms(messageSid, data)`
- `getSms(messageSid)`
- `getAllSms()`
- `getInboundSms()` — direction=inbound
- `getUnreadSms()` — direction=inbound AND read=false
- `markAsRead(messageSid)` — set read=true

---

## webhook.js

Express app sur `127.0.0.1:${WEBHOOK_PORT}`. Tous les logs sur stderr.

### POST /webhook/voice

Appels entrants (form-urlencoded). Champs : CallSid, From, To, CallStatus.

1. `upsertCall(CallSid, { status:'ringing', direction:'inbound', from:From, to:To, startedAt })`
2. Répondre `Content-Type: text/xml` avec TwiML de mise en attente :

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="fr-FR">Un instant, je vous réponds.</Say>
  <Pause length="300"/>
</Response>
```

### POST /webhook/status

Cycle de vie des appels. Champs : CallSid, CallStatus, Duration.

| CallStatus       | callStore                                           |
|------------------|-----------------------------------------------------|
| `ringing`        | status=ringing                                      |
| `in-progress`    | status=active, answeredAt=now                       |
| `completed`      | status=ended, hungUpAt=now, duration ; setTimeout removeCall 5min |
| `busy`/`failed`/`no-answer` | status=ended, reason=CallStatus        |

Répondre 200, body vide.

### POST /webhook/sms

SMS entrants (form-urlencoded). Champs : MessageSid, From, To, Body.

1. `upsertSms(MessageSid, { direction:'inbound', from:From, to:To, body:Body, status:'received', receivedAt, read:false })`
2. Répondre 200, body vide (pas de TwiML nécessaire si on ne répond pas automatiquement).

### GET /webhook/twiml/hold

TwiML statique pour les appels sortants en attente :

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response><Pause length="300"/></Response>
```

`Content-Type: text/xml`

### GET /health

`{ status: "ok", uptime: process.uptime() }`

---

## index.js — Outils MCP

### Outils Voix

| name | args requis | args optionnels | description |
|---|---|---|---|
| `make_call` | `to` | `from` | Appel sortant. Retourne call_sid. |
| `list_incoming_calls` | — | — | Entrants en attente (ringing+inbound) |
| `list_active_calls` | — | — | Appels actifs |
| `list_all_calls` | — | — | Tous les appels du store |
| `get_call_status` | `call_sid` | — | État local de l'appel |
| `hangup_call` | `call_sid` | — | Raccroche |
| `speak_on_call` | `call_sid`, `text` | `language`, `voice` | TTS via redirect TwiML |
| `send_dtmf` | `call_sid`, `digits` | — | Tonalités DTMF |
| `transfer_call` | `call_sid`, `to` | — | Transfert |

Pas de `answer_call`/`reject_call` : les entrants sont auto-répondus dans `/webhook/voice`.

### Outils SMS

| name | args requis | args optionnels | description |
|---|---|---|---|
| `send_sms` | `to`, `body` | `from` | Envoie un SMS. Retourne message_sid. |
| `list_inbound_sms` | — | — | Tous les SMS reçus |
| `list_unread_sms` | — | — | SMS reçus non lus |
| `get_sms` | `message_sid` | — | Détail d'un SMS |
| `mark_sms_read` | `message_sid` | — | Marque comme lu |
| `list_recent_sms` | — | `limit` (défaut 20) | SMS récents via API Twilio (outbound+inbound) |

Après `send_sms`, stocker dans smsStore avec `direction:'outbound'`.

---

## Dockerfile

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY src/ ./src/
ENV NODE_ENV=production
CMD ["node", "src/index.js"]
```

## docker-compose.yml

```yaml
services:
  twilio-mcp:
    build: .
    restart: unless-stopped
    network_mode: host
    env_file: .env
    stdin_open: true
    tty: false
```

---

## Contraintes

- fetch natif, pas de SDK Twilio
- Auth Basic avec btoa(), corps en application/x-www-form-urlencoded via URLSearchParams
- Tous les logs sur stderr, stdout réservé au protocole MCP
- Le TwiML doit être du XML valide — utiliser URLSearchParams pour l'encoding (pas besoin d'échapper manuellement)
- Pas de base de données, state en mémoire uniquement
- Démarrage du conteneur < 3 secondes
