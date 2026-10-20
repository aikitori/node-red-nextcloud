'use strict'
process.env.TZ = 'Europe/Berlin'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const helper = require('node-red-node-test-helper')
const nextcloudNode = require('../nextcloud.js')
const { MockNextcloud } = require('./mock-nextcloud')
const { dailyStandup, upcoming, vcard } = require('./fixtures')

helper.init(require.resolve('node-red'))

const USER = 'anna@example.org'
const PASS = 'secret'

function flow (type, props, address, extra = {}) {
  return [
    Object.assign({ id: 'n1', type, server: 'cfg', wires: [['out']] }, props),
    Object.assign({ id: 'cfg', type: 'nextcloud-credentials', address }, extra),
    { id: 'out', type: 'helper' }
  ]
}

const credentials = { cfg: { user: USER, pass: PASS } }

function collect (node, count, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const msgs = []
    const timer = setTimeout(() => reject(new Error('got ' + msgs.length + ' of ' + count + ' messages')), timeout)
    node.on('input', (msg) => {
      msgs.push(msg)
      if (msgs.length === count) { clearTimeout(timer); resolve(msgs) }
    })
  })
}

function nextError (node, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no error reported')), timeout)
    node.on('call:error', (call) => { clearTimeout(timer); resolve(call) })
  })
}

function mock (options) {
  return new MockNextcloud(Object.assign({
    user: USER,
    pass: PASS,
    calendars: {
      personal: { displayName: 'Personal', objects: [dailyStandup, upcoming()] },
      work: { displayName: 'Work', objects: [] },
      tasks: { displayName: 'Tasks', components: ['VTODO'], objects: [] }
    },
    addressBooks: { contacts: { displayName: 'Contacts', cards: [vcard] } },
    files: { '/Documents/a b.txt': Buffer.from('hello'), '/Documents/sub/x.txt': Buffer.from('x') }
  }, options)).listen()
}

test.afterEach(async () => {
  await helper.unload()
})

test('CalDAV returns events, keeps the input message and filters in UTC', async () => {
  const server = await mock()
  try {
    await helper.load(nextcloudNode, flow('nextcloud-caldav', { calendar: '', pastWeeks: 0, futureWeeks: 1, cache: false }, server.address), credentials)
    const n1 = helper.getNode('n1')
    const got = collect(helper.getNode('out'), 2)
    n1.receive({ payload: 'go', topic: 'cal', keep: { a: 1 } })
    const msgs = await got
    assert.deepStrictEqual(msgs.map((m) => m.payload.name).sort(), ['Personal', 'Work'], 'task list is skipped')
    for (const m of msgs) {
      assert.strictEqual(m.topic, 'cal')
      assert.deepStrictEqual(m.keep, { a: 1 })
    }
    const data = msgs.find((m) => m.payload.name === 'Personal').payload.data
    // 8 standups (today + 7 days), the 24h event and the all-day event
    assert.strictEqual(data.filter((e) => e.summary === 'Daily standup').length, 8)
    assert.strictEqual(data.find((e) => e.summary === '24h timed').allDay, false)
    assert.strictEqual(data.find((e) => e.summary === 'All day').allDay, true)
    const starts = data.map((e) => new Date(e.startDate).getTime())
    assert.deepStrictEqual(starts, starts.slice().sort((a, b) => a - b), 'sorted by start')

    const reports = server.requests.filter((r) => r.method === 'REPORT')
    assert.strictEqual(reports.length, 2, 'one filtered query per calendar, no full download')
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const expectedStart = midnight.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    assert.match(reports[0].body, new RegExp('<c:time-range start="' + expectedStart + '"'))
    assert.match(server.requests[0].path, /\/calendars\/anna%40example\.org\/$/)
  } finally {
    await server.close()
  }
})

test('CalDAV selects a calendar by name from the message', async () => {
  const server = await mock()
  try {
    await helper.load(nextcloudNode, flow('nextcloud-caldav', { calendar: 'Work' }, server.address), credentials)
    const got = collect(helper.getNode('out'), 1)
    helper.getNode('n1').receive({ payload: 1, calendar: 'Personal' })
    const [msg] = await got
    assert.strictEqual(msg.payload.name, 'Personal')
  } finally {
    await server.close()
  }
})

test('CalDAV reports an unknown calendar with the message for catch nodes', async () => {
  const server = await mock()
  try {
    await helper.load(nextcloudNode, flow('nextcloud-caldav', { calendar: 'Nope' }, server.address), credentials)
    const n1 = helper.getNode('n1')
    const err = nextError(n1)
    n1.receive({ payload: 1, _msgid: 'm1' })
    const call = await err
    assert.match(String(call.args[0]), /calendar "Nope" not found, available: "Personal", "Work"/)
    assert.strictEqual(call.args[1]._msgid, 'm1')
  } finally {
    await server.close()
  }
})

test('wrong password gives a clear error instead of "went wrong"', async () => {
  const server = await mock()
  try {
    await helper.load(nextcloudNode, flow('nextcloud-caldav', {}, server.address), { cfg: { user: USER, pass: 'wrong' } })
    const n1 = helper.getNode('n1')
    const err = nextError(n1)
    n1.receive({ payload: 1 })
    assert.match(String((await err).args[0]), /401/)
  } finally {
    await server.close()
  }
})

test('CardDAV parses contacts and keeps the message', async () => {
  const server = await mock()
  try {
    await helper.load(nextcloudNode, flow('nextcloud-carddav', { addressBook: '' }, server.address), credentials)
    const got = collect(helper.getNode('out'), 1)
    helper.getNode('n1').receive({ payload: 1, topic: 'cards' })
    const [msg] = await got
    assert.strictEqual(msg.topic, 'cards')
    assert.strictEqual(msg.payload.name, 'Contacts')
    assert.strictEqual(msg.payload.data[0].FN, 'Anna Example')
    assert.strictEqual(msg.payload.data[0].URL, 'https://example.org/anna')
  } finally {
    await server.close()
  }
})

test('WebDAV list, download and upload against a Nextcloud in a subdirectory', async () => {
  const server = await mock({ prefix: '/nextcloud' })
  try {
    // trailing slash in the configured address must not break the URLs
    await helper.load(nextcloudNode, [
      { id: 'list', type: 'nextcloud-webdav-list', server: 'cfg', directory: 'Documents', wires: [['out']] },
      { id: 'get', type: 'nextcloud-webdav-out', server: 'cfg', filename: '', wires: [['out']] },
      { id: 'put', type: 'nextcloud-webdav-in', server: 'cfg', filename: '', directory: '', wires: [['out']] },
      { id: 'cfg', type: 'nextcloud-credentials', address: server.address + '/' },
      { id: 'out', type: 'helper' }
    ], credentials)
    const out = helper.getNode('out')

    let got = collect(out, 1)
    helper.getNode('list').receive({ payload: 1 })
    let [msg] = await got
    assert.deepStrictEqual(msg.payload.map((e) => [e.filename, e.basename, e.type, e.size, e.mime]).sort(), [
      ['/Documents/a b.txt', 'a b.txt', 'file', 5, 'text/plain'],
      ['/Documents/sub', 'sub', 'directory', 0, undefined]
    ])

    got = collect(out, 1)
    helper.getNode('get').receive({ payload: 1, filename: 'Documents/a b.txt' })
    ;[msg] = await got
    assert.ok(Buffer.isBuffer(msg.payload))
    assert.strictEqual(msg.payload.toString(), 'hello')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-test-'))
    const local = path.join(dir, 'report.txt')
    fs.writeFileSync(local, 'uploaded')
    got = collect(out, 1)
    helper.getNode('put').receive({ payload: 1, filename: local, directory: 'Uploads/2026', topic: 'up' })
    ;[msg] = await got
    assert.deepStrictEqual(msg.payload, { path: '/Uploads/2026/report.txt', size: 8, statusCode: 201 })
    assert.strictEqual(msg.topic, 'up')
    assert.strictEqual(server.files.get('/Uploads/2026/report.txt').toString(), 'uploaded')
    fs.rmSync(dir, { recursive: true })
  } finally {
    await server.close()
  }
})

test('upload of a missing local file is reported, Node-RED keeps running', async () => {
  const server = await mock()
  try {
    await helper.load(nextcloudNode, flow('nextcloud-webdav-in', { filename: '/does/not/exist.txt' }, server.address), credentials)
    const n1 = helper.getNode('n1')
    const err = nextError(n1)
    n1.receive({ payload: 1 })
    assert.match(String((await err).args[0]), /ENOENT/)
    assert.strictEqual(server.requests.length, 0)
  } finally {
    await server.close()
  }
})

function selfSignedCert () {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cert-'))
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1',
      '-days', '1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' })
    const tls = { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }
    fs.rmSync(dir, { recursive: true })
    return tls
  } catch (err) {
    return null
  }
}

const tls = selfSignedCert()

test('"Accept self signed certificates" works for CalDAV', { skip: !tls && 'openssl not available' }, async () => {
  const server = await mock({ tls })
  try {
    await helper.load(nextcloudNode, flow('nextcloud-caldav', { calendar: 'Work' }, server.address, { insecure: true }), credentials)
    const got = collect(helper.getNode('out'), 1)
    helper.getNode('n1').receive({ payload: 1 })
    assert.strictEqual((await got)[0].payload.name, 'Work')
    await helper.unload()

    await helper.load(nextcloudNode, flow('nextcloud-caldav', { calendar: 'Work' }, server.address, { insecure: false }), credentials)
    const n1 = helper.getNode('n1')
    const err = nextError(n1)
    n1.receive({ payload: 1 })
    assert.match(String((await err).args[0]), /self[- ]signed certificate/)
  } finally {
    await server.close()
  }
})
