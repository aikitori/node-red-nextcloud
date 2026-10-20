'use strict'
// Persistent store for the raw calendar data of one CalDAV node, used while the server is unreachable.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const VERSION = 2

// Network problems and server errors fall back to the cache, configuration errors
// (wrong password, unknown calendar, ...) do not
function isOffline (err) {
  return !err || err.statusCode === undefined || err.statusCode >= 500
}

class CalendarCache {
  // file: path of the cache file or null for memory only; key: identifies server and user
  constructor (file, address, user) {
    this.file = file
    this.key = crypto.createHash('sha256').update(String(address) + '\n' + String(user)).digest('hex')
    this.data = null
    this.written = null
  }

  // {fetchedAt, syncToken, entries} of a calendar or null
  get (url) {
    const data = this.load()
    return (data && data.objects[url]) || null
  }

  load () {
    if (this.data) return this.data
    if (!this.file) return null
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      // ignore caches of an older format or another server / user
      if (data.version !== VERSION || data.key !== this.key) return null
      this.data = data
      this.written = JSON.stringify(data)
    } catch (err) {
      return null
    }
    return this.data
  }

  // calendars: [{url, displayName, components, syncToken}], entries: {url: [{href, data}, ...]} with all
  // events of the calendars just fetched, syncToken is the state of these entries
  update (calendars, entries, fetchedAt) {
    const old = this.load()
    const data = { version: VERSION, key: this.key, calendars, objects: {} }
    for (const calendar of calendars) {
      if (entries[calendar.url]) {
        data.objects[calendar.url] = { fetchedAt, syncToken: calendar.syncToken, entries: entries[calendar.url] }
      } else if (old && old.objects[calendar.url]) {
        // calendar was not requested this time, keep its previous state
        data.objects[calendar.url] = old.objects[calendar.url]
      }
    }
    this.data = data
    this.save()
  }

  save () {
    if (!this.file) return
    const json = JSON.stringify(this.data)
    if (json === this.written) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, json, { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    this.written = json
  }

  remove () {
    this.data = null
    this.written = null
    if (this.file) fs.rmSync(this.file, { force: true })
  }
}

module.exports = { CalendarCache, isOffline }
