'use strict'
process.env.TZ = 'Europe/Berlin'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const helper = require('node-red-node-test-helper')
const nextcloudNode = require('../nextcloud.js')
const { MockNextcloud } = require('./mock-nextcloud')
const { dailyStandup, upcoming } = require('./fixtures')

helper.init(require.resolve('node-red'))

const USER = 'anna@example.org'
const PASS = 'secret'

function flow (address, props = {}) {
  return [
    Object.assign({ id: 'cal1', type: 'nextcloud-caldav', server: 'cfg', calendar: '', pastWeeks: 0, futureWeeks: 1, wires: [['out']] }, props),
    { id: 'cfg', type: 'nextcloud-credentials', address },
    { id: 'out', type: 'helper' }
  ]
}

function request (msg = { payload: 1 }, timeout = 3000) {
  const n1 = helper.getNode('cal1')
  const out = helper.getNode('out')
  return new Promise((resolve, reject) => {
    const msgs = []
    const timer = setTimeout(() => resolve({ msgs, error: null }), timeout)
    out.on('input', (m) => {
      msgs.push(m)
      if (msgs.length === 2) { clearTimeout(timer); resolve({ msgs, error: null }) }
    })
    n1.on('call:error', (call) => { clearTimeout(timer); resolve({ msgs, error: String(call.args[0]) }) })
    n1.receive(msg)
  })
}

function startMock () {
  return new MockNextcloud({
    user: USER,
    pass: PASS,
    calendars: {
      personal: { displayName: 'Personal', objects: [dailyStandup, upcoming()] },
      work: { displayName: 'Work', objects: [] }
    }
  }).listen()
}

let userDir
test.beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-userdir-'))
  helper.settings({ userDir })
})
test.afterEach(async () => {
  await helper.unload()
  helper.settings({})
  fs.rmSync(userDir, { recursive: true, force: true })
})

test('falls back to the cache while the server is down, also after a restart', async () => {
  const server = await startMock()
  const address = server.address
  const credentials = { cfg: { user: USER, pass: PASS } }
  await helper.load(nextcloudNode, flow(address), credentials)

  let res = await request()
  assert.strictEqual(res.error, null)
  assert.strictEqual(res.msgs.length, 2)
  assert.ok(res.msgs.every((m) => m.payload.fromCache === false))
  const online = res.msgs.find((m) => m.payload.name === 'Personal').payload

  const file = path.join(userDir, 'nextcloud-cache', 'cal1.json')
  assert.ok(fs.existsSync(file), 'cache file written')
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
  assert.ok(!fs.readFileSync(file, 'utf8').includes(PASS), 'no password in the cache')

  await server.close()

  const n1 = helper.getNode('cal1')
  const warnings = []
  n1.on('call:warn', (call) => warnings.push(String(call.args[0])))
  const statuses = []
  n1.on('call:status', (call) => statuses.push(call.args[0]))

  res = await request({ payload: 1, topic: 'offline' })
  assert.strictEqual(res.error, null)
  const cached = res.msgs.find((m) => m.payload.name === 'Personal')
  assert.strictEqual(cached.payload.fromCache, true)
  assert.strictEqual(cached.topic, 'offline')
  assert.strictEqual(cached.payload.fetchedAt, online.fetchedAt)
  assert.deepStrictEqual(cached.payload.data, online.data)
  assert.strictEqual(statuses[statuses.length - 1].fill, 'yellow')

  await request()
  assert.strictEqual(warnings.filter((w) => /unreachable/.test(w)).length, 1, 'warns once per outage')

  // restart of Node-RED while the server is still down
  await helper.unload()
  await helper.load(nextcloudNode, flow(address), credentials)
  res = await request()
  assert.strictEqual(res.error, null)
  assert.strictEqual(res.msgs.find((m) => m.payload.name === 'Personal').payload.data.length, online.data.length)
  assert.ok(res.msgs.every((m) => m.payload.fromCache === true))
})

test('selected calendar comes from the cache, unknown names are still errors', async () => {
  const server = await startMock()
  const credentials = { cfg: { user: USER, pass: PASS } }
  await helper.load(nextcloudNode, flow(server.address, { calendar: 'Personal' }), credentials)
  await request()
  await server.close()

  let res = await request({ payload: 1 }, 1000)
  assert.deepStrictEqual(res.msgs.map((m) => [m.payload.name, m.payload.fromCache]), [['Personal', true]])

  // Work was never requested, so it is not in the cache
  res = await request({ payload: 1, calendar: 'Work' })
  assert.match(res.error, /calendar not cached yet/)
  res = await request({ payload: 1, calendar: 'Nope' })
  assert.match(res.error, /calendar "Nope" not found/)
})

test('server back online delivers fresh data again', async () => {
  let server = await startMock()
  const port = new URL(server.address).port
  const credentials = { cfg: { user: USER, pass: PASS } }
  await helper.load(nextcloudNode, flow(server.address), credentials)
  await request()
  await server.close()
  let res = await request()
  assert.ok(res.msgs.every((m) => m.payload.fromCache === true))

  server = new MockNextcloud({ user: USER, pass: PASS, calendars: { personal: { displayName: 'Personal', objects: [] } } })
  await new Promise((resolve) => {
    const http = require('http')
    server.server = http.createServer((req, r) => server.handle(req, r)).listen(port, '127.0.0.1', resolve)
  })
  try {
    res = await request({ payload: 1 }, 1000)
    assert.deepStrictEqual(res.msgs.map((m) => [m.payload.name, m.payload.fromCache, m.payload.data.length]), [['Personal', false, 0]])
  } finally {
    await server.close()
  }
})

test('wrong password does not fall back to the cache', async () => {
  const server = await startMock()
  try {
    await helper.load(nextcloudNode, flow(server.address), { cfg: { user: USER, pass: PASS } })
    await request()
    await helper.unload()
    await helper.load(nextcloudNode, flow(server.address), { cfg: { user: USER, pass: 'wrong' } })
    const res = await request()
    assert.match(res.error, /401/)
    assert.strictEqual(res.msgs.length, 0)
  } finally {
    await server.close()
  }
})

test('without cache an outage is an error', async () => {
  const server = await startMock()
  const address = server.address
  await helper.load(nextcloudNode, flow(address, { cache: false }), { cfg: { user: USER, pass: PASS } })
  await request()
  await server.close()
  const res = await request()
  assert.match(res.error, /ECONNREFUSED/)
  assert.ok(!fs.existsSync(path.join(userDir, 'nextcloud-cache')))
})
