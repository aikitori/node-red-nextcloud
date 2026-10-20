'use strict'
// Small in-memory Nextcloud stand-in: CalDAV, CardDAV and WebDAV, enough for the node tests.
const http = require('http')
const https = require('https')

function xmlEscape (s) {
  return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c])
}

function multistatus (responses) {
  return '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" ' +
    'xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:oc="http://owncloud.org/ns">' +
    responses.join('') + '</d:multistatus>'
}

function response (href, props, missing) {
  let xml = '<d:response><d:href>' + href + '</d:href>' +
    '<d:propstat><d:prop>' + props + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>'
  if (missing) {
    xml += '<d:propstat><d:prop>' + missing + '</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>'
  }
  return xml + '</d:response>'
}

class MockNextcloud {
  constructor (options = {}) {
    this.user = options.user || 'anna@example.org'
    this.pass = options.pass || 'secret'
    this.prefix = options.prefix || ''
    this.calendars = options.calendars || {}
    this.addressBooks = options.addressBooks || {}
    this.files = new Map(Object.entries(options.files || {}))
    this.requests = []
    this.tls = options.tls
  }

  listen () {
    const handler = (req, res) => this.handle(req, res)
    this.server = this.tls ? https.createServer(this.tls, handler) : http.createServer(handler)
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => {
      const proto = this.tls ? 'https' : 'http'
      this.address = proto + '://127.0.0.1:' + this.server.address().port + this.prefix
      resolve(this)
    }))
  }

  close () {
    this.server.closeAllConnections()
    return new Promise((resolve) => this.server.close(resolve))
  }

  handle (req, res) {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(req.url, 'http://localhost')
      this.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body: body.toString() })
      const expected = 'Basic ' + Buffer.from(this.user + ':' + this.pass).toString('base64')
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Nextcloud"' })
        return res.end()
      }
      if (!url.pathname.startsWith(this.prefix + '/remote.php/')) {
        res.writeHead(404)
        return res.end()
      }
      const path = decodeURIComponent(url.pathname.slice(this.prefix.length))
      try {
        this.route(req.method, path, body, res)
      } catch (err) {
        res.writeHead(500)
        res.end(err.message)
      }
    })
  }

  sendXml (res, responses) {
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
    res.end(multistatus(responses))
  }

  route (method, path, body, res) {
    const p = this.prefix
    const calHome = '/remote.php/dav/calendars/' + this.user + '/'
    const cardHome = '/remote.php/dav/addressbooks/users/' + this.user + '/'
    const enc = encodeURIComponent(this.user)

    if (method === 'PROPFIND' && path === calHome) {
      const list = [response(p + '/remote.php/dav/calendars/' + enc + '/', '<d:resourcetype><d:collection/></d:resourcetype>',
        '<d:displayname/>')]
      list.push(response(p + '/remote.php/dav/calendars/' + enc + '/inbox/',
        '<d:resourcetype><d:collection/><cal:schedule-inbox/></d:resourcetype>'))
      for (const [id, cal] of Object.entries(this.calendars)) {
        const comps = (cal.components || ['VEVENT']).map((c) => '<cal:comp name="' + c + '"/>').join('')
        list.push(response(p + '/remote.php/dav/calendars/' + enc + '/' + id + '/',
          '<d:displayname>' + xmlEscape(cal.displayName) + '</d:displayname>' +
          '<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>' +
          '<cal:supported-calendar-component-set>' + comps + '</cal:supported-calendar-component-set>'))
      }
      return this.sendXml(res, list)
    }
    if (method === 'REPORT' && path.startsWith(calHome)) {
      const cal = this.calendars[path.slice(calHome.length).replace(/\/$/, '')]
      if (!cal) { res.writeHead(404); return res.end() }
      return this.sendXml(res, (cal.objects || []).map((ics, i) =>
        response(p + '/remote.php/dav/calendars/' + enc + '/x/' + i + '.ics',
          '<d:getetag>"' + i + '"</d:getetag><cal:calendar-data>' + xmlEscape(ics) + '</cal:calendar-data>')))
    }
    if (method === 'PROPFIND' && path === cardHome) {
      const list = [response(p + '/remote.php/dav/addressbooks/users/' + enc + '/', '<d:resourcetype><d:collection/></d:resourcetype>')]
      for (const [id, book] of Object.entries(this.addressBooks)) {
        list.push(response(p + '/remote.php/dav/addressbooks/users/' + enc + '/' + id + '/',
          '<d:displayname>' + xmlEscape(book.displayName) + '</d:displayname>' +
          '<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>'))
      }
      return this.sendXml(res, list)
    }
    if (method === 'REPORT' && path.startsWith(cardHome)) {
      const book = this.addressBooks[path.slice(cardHome.length).replace(/\/$/, '')]
      if (!book) { res.writeHead(404); return res.end() }
      return this.sendXml(res, (book.cards || []).map((vcf, i) =>
        response(p + '/remote.php/dav/addressbooks/users/' + enc + '/x/' + i + '.vcf',
          '<d:getetag>"' + i + '"</d:getetag><card:address-data>' + xmlEscape(vcf) + '</card:address-data>')))
    }
    if (path.startsWith('/remote.php/webdav/')) {
      return this.webdav(method, path.slice('/remote.php/webdav'.length), body, res)
    }
    res.writeHead(404)
    res.end()
  }

  webdav (method, file, body, res) {
    const hrefOf = (f) => this.prefix + '/remote.php/webdav' + f.split('/').map(encodeURIComponent).join('/')
    if (method === 'GET') {
      if (!this.files.has(file)) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      return res.end(this.files.get(file))
    }
    if (method === 'PUT') {
      const existed = this.files.has(file)
      this.files.set(file, body)
      // Nextcloud answers with an empty body
      res.writeHead(existed ? 204 : 201)
      return res.end()
    }
    if (method === 'PROPFIND') {
      const dir = file.replace(/\/$/, '')
      const entries = new Map()
      for (const [name, data] of this.files) {
        if (!name.startsWith(dir + '/')) continue
        const rest = name.slice(dir.length + 1)
        const first = rest.split('/')[0]
        if (rest.includes('/')) entries.set(dir + '/' + first + '/', null)
        else entries.set(name, data)
      }
      if (!entries.size && dir !== '') { res.writeHead(404); return res.end() }
      const list = [response(hrefOf(dir + '/'), '<d:resourcetype><d:collection/></d:resourcetype>')]
      for (const [name, data] of entries) {
        if (data === null) {
          list.push(response(hrefOf(name), '<d:getlastmodified>Sun, 18 Oct 2026 10:00:00 GMT</d:getlastmodified>' +
            '<d:resourcetype><d:collection/></d:resourcetype>', '<d:getcontentlength/><d:getcontenttype/>'))
        } else {
          list.push(response(hrefOf(name), '<d:getlastmodified>Sun, 18 Oct 2026 10:00:00 GMT</d:getlastmodified>' +
            '<d:getcontentlength>' + data.length + '</d:getcontentlength><d:resourcetype/>' +
            '<d:getcontenttype>text/plain; charset=utf-8</d:getcontenttype>'))
        }
      }
      return this.sendXml(res, list)
    }
    res.writeHead(405)
    res.end()
  }
}

module.exports = { MockNextcloud }
