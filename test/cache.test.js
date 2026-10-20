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
const { dailyStandup, upcoming, calendar, ymd, inDays } = require('./fixtures')

const later = calendar([
  'BEGIN:VEVENT', 'UID:later', 'DTSTAMP:20250101T000000Z',
  'DTSTART;TZID=Europe/Berlin:' + ymd(inDays(10)) + 'T120000',
  'DTEND;TZID=Europe/Berlin:' + ymd(inDays(10)) + 'T130000',
  'SUMMARY:In ten days', 'END:VEVENT'
])

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

// every mock is closed after each test, also when an assertion failed halfway
const servers = []

function startMock () {
  return track(new MockNextcloud({
    user: USER,
    pass: PASS,
    calendars: {
      personal: { displayName: 'Personal', objects: [dailyStandup, upcoming(), later] },
      work: { displayName: 'Work', objects: [] }
    }
  }))
}

function track (server) {
  servers.push(server)
  return server.listen()
}

let userDir
test.beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-userdir-'))
  helper.settings({ userDir })
})
test.afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
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
  servers.push(server)
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

function reports (server) {
  return server.requests.filter((r) => r.method === 'REPORT')
}

function calDavTime (date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

test('whole calendar is cached, events after the output range are known offline', async () => {
  const server = await startMock()
  const address = server.address
  const credentials = { cfg: { user: USER, pass: PASS } }
  await helper.load(nextcloudNode, flow(address, { calendar: 'Personal', futureWeeks: 1 }), credentials)
  let res = await request({ payload: 1 }, 1000)
  assert.doesNotMatch(reports(server)[0].body, /time-range/)
  assert.ok(!res.msgs[0].payload.data.some((e) => e.summary === 'In ten days'), 'event after the output range is not sent')
  await server.close()

  // offline with a longer range (as on later days of an outage)
  await helper.unload()
  await helper.load(nextcloudNode, flow(address, { calendar: 'Personal', futureWeeks: 3 }), credentials)
  res = await request({ payload: 1 }, 1000)
  const personal = res.msgs[0].payload
  assert.strictEqual(personal.fromCache, true)
  assert.ok(personal.data.some((e) => e.summary === 'In ten days'), 'event from the cached calendar')
})

test('only changes are downloaded, unknown sync token downloads everything again', async () => {
  const server = await startMock()
  try {
    await helper.load(nextcloudNode, flow(server.address, { calendar: 'Personal', futureWeeks: 2 }), { cfg: { user: USER, pass: PASS } })
    const summaries = async () => (await request({ payload: 1 }, 1000)).msgs[0].payload.data.map((e) => e.summary)
    assert.ok((await summaries()).includes('In ten days'))
    assert.match(reports(server)[0].body, /<d:sync-token><\/d:sync-token>/)

    await summaries()
    assert.strictEqual(reports(server).length, 1, 'unchanged calendar comes from the cache')

    // remove "later": only the deletion is transferred
    server.calendars.personal.objects = [dailyStandup, upcoming()]
    let list = await summaries()
    assert.ok(!list.includes('In ten days'))
    assert.ok(list.includes('Daily standup'))
    assert.strictEqual(reports(server).length, 2)
    assert.match(reports(server)[1].body, /<d:sync-token>http/)

    // server forgot the token: 403, then full download
    server.snapshots.clear()
    server.calendars.personal.objects.push(later)
    list = await summaries()
    assert.ok(list.includes('In ten days'))
    assert.ok(list.includes('Daily standup'))
    assert.strictEqual(reports(server).length, 4)
  } finally {
    await server.close()
  }
})

test('without cache only the output range is requested', async () => {
  const server = await startMock()
  try {
    await helper.load(nextcloudNode, flow(server.address, { calendar: 'Personal', futureWeeks: 1, cache: false }),
      { cfg: { user: USER, pass: PASS } })
    await request({ payload: 1 }, 1000)
    const end = new Date()
    end.setHours(23, 59, 59, 999)
    end.setDate(end.getDate() + 7)
    assert.strictEqual(reports(server).pop().body.match(/end="(\d{8}T\d{6}Z)"/)[1], calDavTime(end))
  } finally {
    await server.close()
  }
})
