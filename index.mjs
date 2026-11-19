// accounted-imap-intake: pollar ett IMAP-konto och laddar upp
// PDF/bildbilagor till Accounted via MCP-dokumentflödet
// (gnubok_create_document_upload -> PUT bytes -> gnubok_complete_document_upload).
// Kör OCR + inkorgsposten på Accounted-sida. Mejlet lämnas orört i INBOX.
//
// Env:
//   IMAP_HOST, IMAP_PORT (993), IMAP_USER, IMAP_PASS (alla obligatoriska utom PORT)
//   ACCOUNTED_URL (obligatorisk, din installations URL)
//   ACCOUNTED_API_KEY (obligatorisk, gnubok_sk_... med transactions:write-scope)
//   POLL_INTERVAL_MS (default 60000; IMAP IDLE om servern stödjer det)
//   STATE_FILE (/data/state.json: senaste UID per mailbox)
//   ERROR_DIR (/data/errors: bilagor som misslyckades)

import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
])
const MAX_BYTES = 10 * 1024 * 1024 // Accounteds gräns

const env = (k, d) => process.env[k] ?? d
const IMAP = {
  host: env('IMAP_HOST'),
  port: Number(env('IMAP_PORT', 993)),
  auth: {
    user: env('IMAP_USER'),
    pass: env('IMAP_PASS'),
  },
  tls: true,
}
const ACCOUNTED_URL = env('ACCOUNTED_URL')
const API_KEY = env('ACCOUNTED_API_KEY')
const POLL_MS = Number(env('POLL_INTERVAL_MS', 60_000))
const STATE_FILE = env('STATE_FILE', '/data/state.json')
const ERROR_DIR = env('ERROR_DIR', '/data/errors')

if (!IMAP.auth.pass) { console.error('IMAP_PASS saknas'); process.exit(1) }
if (!IMAP.host) { console.error('IMAP_HOST saknas'); process.exit(1) }
if (!IMAP.auth.user) { console.error('IMAP_USER saknas'); process.exit(1) }
if (!ACCOUNTED_URL) { console.error('ACCOUNTED_URL saknas'); process.exit(1) }
if (!API_KEY) { console.error('ACCOUNTED_API_KEY saknas'); process.exit(1) }
if (!API_KEY.startsWith('gnubok_sk_')) { console.error('ACCOUNTED_API_KEY måste börja med gnubok_sk_'); process.exit(1) }
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
fs.mkdirSync(ERROR_DIR, { recursive: true })

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return { lastUid: 0, seen: [] } }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s))
  // seen-listan får inte växa oändligt: behåll senaste 500
  if (s.seen.length > 500) s.seen = s.seen.slice(-500)
}

// ── Accounted MCP-anrop ──────────────────────────────────────
const MCP = `${ACCOUNTED_URL}/api/extensions/ext/mcp-server/mcp`
async function mcp(method, params) {
  const res = await fetch(MCP, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${API_KEY}`,
      'x-accounted-client': 'imap-intake',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: crypto.randomUUID(), method, params: {
        ...params,
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      },
    }),
  })
  if (res.status === 401) throw new Error('Accounted: 401 — ogiltig/avslutad API-nyckel')
  const ct = res.headers.get('content-type') ?? ''
  const body = ct.includes('text/event-stream') ? await parseSse(res) : await res.json()
  if (!res.ok || body.error) {
    throw new Error(`Accounted ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 300)}`)
  }
  return unwrapToolResult(body.result)
}
// tools/call-svaret kommer i flera former beroende på klient/server-version:
// { content: [{ json }] } | { content: [{ text: '<json>' }] } | resultatet direkt.
function unwrapToolResult(result) {
  const c = result?.content?.[0]
  if (c?.json) return c.json
  if (typeof c?.text === 'string') {
    try { return JSON.parse(c.text) } catch { /* inte JSON: fallback */ }
  }
  if (result?.structuredContent) return result.structuredContent
  return result
}
async function parseSse(res) {
  const text = await res.text()
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim() === '[DONE]' ? null : line.slice(5)
      if (payload) { try { return JSON.parse(payload) } catch {} }
    }
  }
  return {}
}

async function uploadToAccounted(fileName, mimeType, buffer, emailMeta) {
  // 1) reservera uppladdnings-URL
  const create = await mcp('tools/call', {
    name: 'gnubok_create_document_upload',
    arguments: { file_name: fileName, mime_type: mimeType },
  })
  const created = create.content?.[0]?.json ?? create
  const { upload_id, upload_url } = created
  if (!upload_id || !upload_url) throw new Error(`Oväntat create-svar: ${JSON.stringify(created).slice(0, 200)}`)

  // 2) PUT filbytes (max 3 försök)
  let putOk = false
  for (let i = 0; i < 3 && !putOk; i++) {
    const put = await fetch(upload_url, {
      method: 'PUT',
      headers: { 'content-type': mimeType },
      body: buffer,
    })
    if (put.ok) { putOk = true; break }
    if (put.status >= 400 && put.status < 500 && put.status !== 429) {
      throw new Error(`PUT ${put.status}: permanent, avbryter`)
    }
    await sleep(2000 * (i + 1))
  }
  if (!putOk) throw new Error('PUT misslyckades efter 3 försök')

  // 3) complete: OCR + inkorgspost (idempotent på upload_id)
  const complete = await mcp('tools/call', {
    name: 'gnubok_complete_document_upload',
    arguments: { upload_id, file_name: fileName, mime_type: mimeType },
  })
  const result = complete.content?.[0]?.json ?? complete
  return result
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }))
}

// ── Huvudloop ────────────────────────────────────────────────
async function processMailbox() {
  const client = new ImapFlow({ ...IMAP, logger: false, emitLogs: false })
  await client.connect()
  try {
    const lock = await client.getMailboxLock('INBOX')
    try {
      const state = loadState()
      const status = client.mailbox
      const highestUid = status.uidNext - 1
      // Hämta UID >= senaste (nya sedan sist, + ev. misslyckade som inte markerats klara)
      const range = `${Math.max(state.lastUid, 0) + 1}:*`
      let fetched = 0
      for await (const msg of client.fetch({ uid: range }, { uid: true, envelope: true, source: true, bodyStructure: true })) {
        fetched++
        const uid = msg.uid
        if (uid <= state.lastUid) continue // redan helt klara
        try {
          const parsed = await simpleParser(msg.source)
          const attachments = (parsed.attachments ?? []).filter(
            a => a.contentType && ALLOWED_MIME.has(a.contentType.split(';')[0].trim().toLowerCase()) && a.content?.length > 0
          )
          if (attachments.length === 0) {
            log('info', 'inga godkända bilagor, hoppar', { uid, from: parsed.from?.text, subject: parsed.subject })
          }
          for (const att of attachments) {
            const size = att.content.length
            if (size > MAX_BYTES) {
              log('warn', 'bilaga för stor (>10MB), till felkö', { uid, filename: att.filename, size })
              saveError(att, parsed, 'too_large')
              continue
            }
            const fileName = sanitize(att.filename ?? `bilaga-${uid}-${Date.now()}`)
            try {
              const result = await uploadToAccounted(fileName, att.contentType.split(';')[0].trim(), att.content, parsed)
              log('info', 'uppladdad till Accounted', {
                uid, fileName,
                document_id: result?.document_id,
                deduplicated: result?.deduplicated,
                inbox_item_id: result?.inbox_item_id,
              })
            } catch (err) {
              log('error', 'uppladdning misslyckades, till felkö', { uid, fileName, error: String(err).slice(0, 200) })
              saveError(att, parsed, String(err).slice(0, 200))
            }
          }
          state.lastUid = Math.max(state.lastUid, uid)
          saveState(state)
        } catch (err) {
          log('error', 'kunde inte tolka mejl', { uid, error: String(err).slice(0, 200) })
        }
      }
      // Om INBOX tömmts/reparerats kan uidNext vara lägre: nollställ aldrig uppåt, men skydda mot evighetsloop
      if (fetched === 0 && highestUid < state.lastUid) {
        log('warn', 'mailbox UID sjönk (importerad om?), behåller state')
      }
      log('info', 'poll klar', { processed: fetched, lastUid: state.lastUid })
    } finally { lock.release() }
  } finally { await client.logout().catch(() => client.close()) }
}

function sanitize(name) {
  // Sätt ihop filnamn utan ogiltiga tecken och utan åäö-problematik
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200)
}
function saveError(att, parsed, reason) {
  try {
    const file = path.join(ERROR_DIR, `${Date.now()}-${sanitize(att.filename ?? 'bilaga')}`)
    fs.writeFileSync(file, att.content)
    fs.writeFileSync(`${file}.json`, JSON.stringify({ reason, from: parsed.from?.text, subject: parsed.subject, date: parsed.date }))
  } catch (e) { log('error', 'kunde inte spara felkö', { error: String(e) }) }
}

async function main() {
  log('info', 'imap-intake startar', { imap: IMAP.user, accounted: ACCOUNTED_URL, pollMs: POLL_MS })
  // engångskörning: EXIT_AFTER_RUN=1 (för test/CI)
  if (process.env.EXIT_AFTER_RUN === '1') { await processMailbox(); return }
  // loop med felåterhämtning: en trasig cykel stoppar aldrig tjänsten
  for (;;) {
    try { await processMailbox() }
    catch (err) { log('error', 'cykel misslyckades', { error: String(err).slice(0, 300) }) }
    await sleep(POLL_MS)
  }
}
main()
