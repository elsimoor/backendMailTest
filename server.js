/*
 * Temporary e‑mail backend server
 *
 * This file implements both an HTTP API (via Express) and an SMTP server to
 * receive inbound messages.  Mailboxes live in Redis with a 15‑minute TTL
 * and messages are optionally persisted to MongoDB.  Outbound messages are
 * delivered via Nodemailer using the provided SMTP relay credentials.
 */

const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const { createTransport } = require('nodemailer');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const { createClient } = require('redis');
const { nanoid } = require('nanoid');

// Configuration from environment variables
const {
  MONGODB_URI,
  REDIS_URL,
  DOMAIN,
  API_PORT = 3001,
  SMTP_PORT = 2525,
  SMTP_HOST,
  SMTP_USER,
  SMTP_PASS,
  SMTP_SECURE = 'false'
} = process.env;

if (!DOMAIN) {
  console.error('Error: DOMAIN environment variable must be set');
  process.exit(1);
}

// Initialize MongoDB client (optional)
const mongoClient = new MongoClient(MONGODB_URI || '', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});
let mongoDb;

const redisClient = createClient({
    username: 'default',
    password: 'A1XB6oGEMjNgYvRZ0rt3ud2wVwn5wAMD',
    socket: {
        host: 'redis-17210.c281.us-east-1-2.ec2.redns.redis-cloud.com',
        port: 17210
    }
});

redisClient.on('error', err => console.log('Redis Client Error', err));
// Initialize SMTP transport for outbound email
const mailTransport = createTransport({
  host: SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: SMTP_SECURE === 'true',
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS
  }
});

// Create Express application
const app = express();
app.use(cors());
app.use(bodyParser.json());

/**
 * Generate a new mailbox.
 * - Creates an inbox key in Redis with a TTL of 15 minutes (900 seconds).
 * - Optionally store metadata in MongoDB.
 */
app.post('/create', async (req, res) => {
  try {
    const id = nanoid(8); // 8‑character random string
    const email = `${id}@${DOMAIN}`;
    const inboxKey = `inbox:${id}`;
    // Ensure mailbox does not already exist
    await redisClient.del(inboxKey);
    // Create an empty list and set TTL.  Redis requires at least one
    // element for RPUSH, so we push a dummy value.  We keep this
    // placeholder in the list and filter it out when reading messages.  If
    // we removed it, the key would disappear and expire could not be set.
    await redisClient.rPush(inboxKey, '__init__');
    await redisClient.expire(inboxKey, 15 * 60);
    // Store meta for quick look up of remaining TTL
    const metaKey = `meta:${id}`;
    await redisClient.set(metaKey, email, { EX: 15 * 60 });
    res.json({ id, email, expiresIn: 15 * 60 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed_to_create_mailbox' });
  }
});

/**
 * Retrieve messages for a mailbox.
 * Returns an array of messages and remaining seconds until expiration.
 */
app.get('/inbox/:id', async (req, res) => {
  const id = req.params.id;
  const inboxKey = `inbox:${id}`;
  try {
    const ttl = await redisClient.ttl(inboxKey);
    if (ttl <= 0) {
      return res.status(404).json({ error: 'mailbox_expired' });
    }
    const messages = await redisClient.lRange(inboxKey, 0, -1);
    // Filter out the dummy placeholder element ("__init__") used to
    // initialize the list.  If it's not the placeholder, parse JSON.
    const parsed = messages
      .filter((m) => m && m.length > 0 && m !== '__init__')
      .map((m) => {
        try {
          return JSON.parse(m);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    res.json({ messages: parsed, expiresIn: ttl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed_to_fetch_inbox' });
  }
});

/**
 * Send an email from a temporary address.
 * Expects JSON body: { id, to, subject, body }
 */
app.post('/send', async (req, res) => {
  const { id, to, subject, body } = req.body;
  if (!id || !to) {
    return res.status(400).json({ error: 'missing_parameters' });
  }
  const inboxKey = `inbox:${id}`;
  try {
    const ttl = await redisClient.ttl(inboxKey);
    if (ttl <= 0) {
      return res.status(404).json({ error: 'mailbox_expired' });
    }
    const fromEmail = `${id}@${DOMAIN}`;
    await mailTransport.sendMail({
      from: fromEmail,
      to,
      subject: subject || '(no subject)',
      text: body || '',
      html: body || ''
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed_to_send' });
  }
});

/**
 * Start the API server and the SMTP server.
 */
async function start() {
  try {
    // Connect to Redis
    await redisClient.connect();
    console.log('Connected to Redis');
    // Connect to MongoDB if URI provided
    if (MONGODB_URI) {
      await mongoClient.connect();
      mongoDb = mongoClient.db();
      console.log('Connected to MongoDB');
    }

    // Start Express API
    app.listen(API_PORT, () => {
      console.log(`API server listening on port ${API_PORT}`);
    });

    // Start SMTP server for inbound mail
    const smtpServer = new SMTPServer({
      disabledCommands: ['AUTH'],
      logger: false,
      onData(stream, session, callback) {
        simpleParser(stream)
          .then(async (parsed) => {
            const recipients = [];
            if (parsed.to && parsed.to.value) {
              parsed.to.value.forEach((addr) => recipients.push(addr.address));
            }
            if (parsed.cc && parsed.cc.value) {
              parsed.cc.value.forEach((addr) => recipients.push(addr.address));
            }
            // Deliver to each recipient if inbox exists
            for (const address of recipients) {
              if (!address) continue;
              const [local] = address.split('@');
              const domain = address.split('@')[1];
              if (domain && domain.toLowerCase() === DOMAIN.toLowerCase()) {
                const inboxKey = `inbox:${local}`;
                const exists = await redisClient.exists(inboxKey);
                if (exists) {
                  const msg = {
                    from: parsed.from ? parsed.from.text : '',
                    subject: parsed.subject || '',
                    body: parsed.text || '',
                    html: parsed.html || '',
                    ts: Date.now()
                  };
                  await redisClient.rPush(inboxKey, JSON.stringify(msg));
                  // Synchronize TTL of the inbox with meta key.  Without this the
                  // list might not expire when the mailbox expires.  If meta does
                  // not exist, TTL returns -2 and expire is skipped.
                  const metaKey = `meta:${local}`;
                  const ttl = await redisClient.ttl(metaKey);
                  if (ttl > 0) {
                    await redisClient.expire(inboxKey, ttl);
                  }
                  // Persist to MongoDB
                  if (mongoDb) {
                    await mongoDb.collection('emails').insertOne({ inboxId: local, ...msg });
                  }
                }
              }
            }
          })
          .then(() => callback())
          .catch((err) => {
            console.error('Error parsing incoming mail:', err);
            callback(err);
          });
      }
    });
    smtpServer.on('error', (err) => {
      console.error('SMTP server error:', err);
    });
    smtpServer.listen(SMTP_PORT, () => {
      console.log(`SMTP server listening on port ${SMTP_PORT}`);
    });
  } catch (err) {
    console.error('Failed to start servers:', err);
    process.exit(1);
  }
}

start();