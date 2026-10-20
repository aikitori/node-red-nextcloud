'use strict'
// Minimal WebDAV / CalDAV / CardDAV client for Nextcloud, built on node's http(s) modules.
const http = require('http')
const https = require('https')
const { DOMParser } = require('@xmldom/xmldom')

const NS_DAV = 'DAV:'
const NS_CALDAV = 'urn:ietf:params:xml:ns:caldav'
const NS_CARDDAV = 'urn:ietf:params:xml:ns:carddav'

const DEFAULT_TIMEOUT = 30000
const MAX_REDIRECTS = 5

class DavError extends Error {
  constructor (message, statusCode) {
    super(message)
    this.name = 'DavError'
    this.statusCode = statusCode
  }
}

function encodePath (p) {
  return p.split('/').map(encodeURIComponent).join('/')
}

function normalizePath (p) {
  return ('/' + (p || '')).replace(/\\/g, '/').replace(/\/{2,}/g, '/')
}

function escapeXml (s) {
  return String(s).replace(/[<>&"']/g, (c) => '&#' + c.charCodeAt(0) + ';')
}

// Format a Date as CalDAV UTC time (e.g. 20261019T220000Z)
function toCalDavTime (date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function children (el, ns, name) {
  const out = []
  if (!el) return out
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.namespaceURI === ns && n.localName === name) out.push(n)
  }
  return out
}

function child (el, ns, name) {
  return children(el, ns, name)[0]
}

function text (el) {
  return el ? el.textContent : undefined
}

function parseXml (body) {
  let doc
  try {
    doc = new DOMParser().parseFromString(body.toString('utf8'), 'text/xml')
  } catch (err) {
    throw new DavError('invalid XML response: ' + err.message)
  }
  if (!doc || !doc.documentElement) throw new DavError('invalid XML response')
  return doc
}

// Parses a multistatus response into [{ href, props }] where props is the merged
// <d:prop> element content of all propstats with a 2xx status.
function parseMultistatus (body) {
  const doc = parseXml(body)
  const root = doc.documentElement
  if (root.namespaceURI !== NS_DAV || root.localName !== 'multistatus') {
    throw new DavError('unexpected XML response, expected multistatus')
  }
  return children(root, NS_DAV, 'response').map((response) => {
    const props = []
    for (const propstat of children(response, NS_DAV, 'propstat')) {
      const status = text(child(propstat, NS_DAV, 'status')) || ''
      if (!/\s2\d\d\s/.test(status + ' ')) continue
      const prop = child(propstat, NS_DAV, 'prop')
      for (let n = prop && prop.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 1) props.push(n)
      }
    }
    return {
      href: text(child(response, NS_DAV, 'href')),
      prop (ns, name) {
        return props.find((p) => p.namespaceURI === ns && p.localName === name)
      }
    }
  })
}

class NextcloudClient {
  constructor (options) {
    this.base = String(options.address || '').trim().replace(/\/+$/, '')
    this.user = options.user || ''
    this.pass = options.pass || ''
    this.timeout = options.timeout || DEFAULT_TIMEOUT
    let url
    try {
      url = new URL(this.base)
    } catch (err) {
      throw new DavError('invalid server address "' + options.address + '"')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new DavError('invalid server address "' + options.address + '", expected http(s)://')
    }
    this.basePath = url.pathname.replace(/\/+$/, '')
    this.agents = {
      'http:': new http.Agent({ keepAlive: true }),
      'https:': new https.Agent({ keepAlive: true, rejectUnauthorized: !options.insecure })
    }
  }

  close () {
    this.agents['http:'].destroy()
    this.agents['https:'].destroy()
  }

  get userPath () {
    return encodeURIComponent(this.user)
  }

  url (path) {
    return this.base + path
  }

  // Resolves to { statusCode, headers, body } for 2xx responses, rejects with a DavError otherwise.
  request (method, url, options = {}, redirects = 0) {
    return new Promise((resolve, reject) => {
      const target = new URL(url)
      const lib = target.protocol === 'https:' ? https : http
      const headers = Object.assign({}, options.headers)
      let body
      if (options.body !== undefined) {
        body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body)
        headers['Content-Length'] = body.length
      }
      // credentials are only sent to the configured server, never to a redirect target elsewhere
      if (target.origin === new URL(this.base).origin) {
        headers.Authorization = 'Basic ' + Buffer.from(this.user + ':' + this.pass).toString('base64')
      }
      const req = lib.request(target, { method, headers, agent: this.agents[target.protocol] }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('error', reject)
        res.on('end', () => {
          const status = res.statusCode
          if ([301, 302, 307, 308].includes(status) && res.headers.location) {
            if (redirects >= MAX_REDIRECTS) return reject(new DavError(method + ' ' + url + ': too many redirects', status))
            const next = new URL(res.headers.location, target).toString()
            return resolve(this.request(method, next, options, redirects + 1))
          }
          if (status < 200 || status >= 300) {
            return reject(new DavError(method + ' ' + target.pathname + ' failed: ' + status + ' ' + (res.statusMessage || ''), status))
          }
          resolve({ statusCode: status, headers: res.headers, body: Buffer.concat(chunks) })
        })
      })
      req.setTimeout(this.timeout, () => {
        req.destroy(new DavError(method + ' ' + target.pathname + ' failed: timeout after ' + this.timeout + ' ms'))
      })
      req.on('error', (err) => {
        reject(err instanceof DavError ? err : new DavError(method + ' ' + target.pathname + ' failed: ' + err.message))
      })
      req.end(body)
    })
  }

  async xmlRequest (method, url, depth, xml) {
    const res = await this.request(method, url, {
      headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0" encoding="utf-8"?>' + xml
    })
    return parseMultistatus(res.body)
  }

  async listCollections (homePath, ns, type) {
    const home = this.url(homePath)
    const responses = await this.xmlRequest('PROPFIND', home, 1,
      '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
      '<d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop>' +
      '</d:propfind>')
    const result = []
    for (const r of responses) {
      if (!child(r.prop(NS_DAV, 'resourcetype'), ns, type)) continue
      const url = new URL(r.href, home).toString()
      const components = children(r.prop(NS_CALDAV, 'supported-calendar-component-set'), NS_CALDAV, 'comp')
        .map((c) => c.getAttribute('name'))
      const displayName = text(r.prop(NS_DAV, 'displayname')) ||
        decodeURIComponent(new URL(url).pathname.replace(/\/+$/, '').split('/').pop())
      result.push({ url, displayName, components })
    }
    return result
  }

  listCalendars () {
    return this.listCollections('/remote.php/dav/calendars/' + this.userPath + '/', NS_CALDAV, 'calendar')
  }

  listAddressBooks () {
    return this.listCollections('/remote.php/dav/addressbooks/users/' + this.userPath + '/', NS_CARDDAV, 'addressbook')
  }

  // Returns the raw iCalendar data of all events overlapping [start, end)
  async calendarQuery (calendarUrl, start, end) {
    const responses = await this.xmlRequest('REPORT', calendarUrl, 1,
      '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
      '<d:prop><d:getetag/><c:calendar-data/></d:prop>' +
      '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">' +
      '<c:time-range start="' + escapeXml(toCalDavTime(start)) + '" end="' + escapeXml(toCalDavTime(end)) + '"/>' +
      '</c:comp-filter></c:comp-filter></c:filter>' +
      '</c:calendar-query>')
    return responses
      .map((r) => ({ href: r.href, data: text(r.prop(NS_CALDAV, 'calendar-data')) }))
      .filter((r) => r.data)
  }

  async addressBookQuery (addressBookUrl) {
    const responses = await this.xmlRequest('REPORT', addressBookUrl, 1,
      '<c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">' +
      '<d:prop><d:getetag/><c:address-data/></d:prop>' +
      '</c:addressbook-query>')
    return responses
      .map((r) => ({ href: r.href, data: text(r.prop(NS_CARDDAV, 'address-data')) }))
      .filter((r) => r.data)
  }

  // WebDAV: same output format as the webdav package 1.x used before
  async listDirectory (directory) {
    const rootPath = this.basePath + '/remote.php/webdav'
    const dir = normalizePath(directory).replace(/\/$/, '') || '/'
    const responses = await this.xmlRequest('PROPFIND', this.url('/remote.php/webdav' + encodePath(dir)), 1,
      '<d:propfind xmlns:d="DAV:"><d:prop>' +
      '<d:getlastmodified/><d:getcontentlength/><d:resourcetype/><d:getcontenttype/>' +
      '</d:prop></d:propfind>')
    const result = []
    for (const r of responses) {
      let path = decodeURIComponent(new URL(r.href, this.base + '/').pathname)
      if (path.startsWith(rootPath)) path = path.slice(rootPath.length)
      path = normalizePath(path).replace(/(.)\/$/, '$1')
      if (path === dir) continue
      const isDir = !!child(r.prop(NS_DAV, 'resourcetype'), NS_DAV, 'collection')
      const stat = {
        filename: path,
        basename: path.split('/').pop(),
        lastmod: text(r.prop(NS_DAV, 'getlastmodified')),
        size: parseInt(text(r.prop(NS_DAV, 'getcontentlength')) || '0', 10),
        type: isDir ? 'directory' : 'file'
      }
      if (!isDir) stat.mime = (text(r.prop(NS_DAV, 'getcontenttype')) || '').split(';')[0]
      result.push(stat)
    }
    return result
  }

  async getFile (filename) {
    const res = await this.request('GET', this.url('/remote.php/webdav' + encodePath(normalizePath(filename))))
    return res.body
  }

  async putFile (filename, data) {
    const res = await this.request('PUT', this.url('/remote.php/webdav' + encodePath(normalizePath(filename))), {
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data
    })
    return res.statusCode
  }
}

module.exports = { NextcloudClient, DavError, normalizePath, toCalDavTime, parseMultistatus }
