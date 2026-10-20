module.exports = function (RED) {
  const fs = require('fs')
  const path = require('path')
  const { NextcloudClient, normalizePath } = require('./lib/dav')
  const { expandEvents, sortEvents, parseVCard } = require('./lib/ical')
  const { CalendarCache, isOffline } = require('./lib/cache')

  function NextcloudConfigNode (config) {
    RED.nodes.createNode(this, config)
    this.address = config.address
    this.insecure = config.insecure
    const node = this
    let client = null

    // one client (and connection pool) per server, created on first use
    node.getClient = function () {
      if (!client) {
        const credentials = node.credentials || {}
        client = new NextcloudClient({
          address: node.address,
          user: credentials.user,
          pass: credentials.pass,
          insecure: !!node.insecure
        })
      }
      return client
    }

    node.on('close', function () {
      if (client) client.close()
      client = null
    })
  }
  RED.nodes.registerType('nextcloud-credentials', NextcloudConfigNode, {
    credentials: {
      user: { type: 'text' },
      pass: { type: 'password' }
    }
  })

  // Wraps an async input handler: errors go to done() (catch node), status shows progress.
  // The handler may resolve to a node status that is shown after success.
  function handleInput (node, prefix, handler) {
    node.on('input', function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments) }
      done = done || function (err) { if (err) node.error(err, msg) }
      if (!node.server) {
        done(new Error(prefix + ' -> no server configured.'))
        return
      }
      node.status({ fill: 'blue', shape: 'dot', text: 'requesting' })
      Promise.resolve()
        .then(() => handler(node.server.getClient(), msg, send))
        .then((status) => {
          node.status(status || {})
          done()
        }, (err) => {
          const message = prefix + ' -> ' + (err && err.message ? err.message : err)
          node.status({ fill: 'red', shape: 'ring', text: message.slice(0, 60) })
          done(new Error(message))
        })
    })
  }

  function numberOr (value, fallback) {
    const n = parseFloat(value)
    return isNaN(n) ? fallback : n
  }

  function selectCollections (collections, name, kind) {
    if (!name) return collections
    const selected = collections.filter((c) => c.displayName === name)
    if (!selected.length) {
      throw new Error(kind + ' "' + name + '" not found, available: ' +
        collections.map((c) => '"' + c.displayName + '"').join(', '))
    }
    return selected
  }

  function NextcloudCalDav (config) {
    RED.nodes.createNode(this, config)
    this.server = RED.nodes.getNode(config.server)
    this.calendar = config.calendar
    this.pastWeeks = numberOr(config.pastWeeks, 0)
    this.futureWeeks = numberOr(config.futureWeeks, 4)
    // cache is on unless switched off explicitly (also for nodes created before the option existed)
    this.useCache = config.cache !== false
    const node = this
    let cache = null
    let offline = false

    if (node.useCache && node.server) {
      const credentials = node.server.credentials || {}
      const file = RED.settings.userDir ? path.join(RED.settings.userDir, 'nextcloud-cache', node.id + '.json') : null
      cache = new CalendarCache(file, node.server.address, credentials.user)
    }

    // only calendars that can hold events (skips task lists)
    function eventCalendars (calendars) {
      return calendars.filter((c) => !c.components.length || c.components.includes('VEVENT'))
    }

    async function fetchOnline (client, name, startDate, endDate) {
      const calendars = eventCalendars(await client.listCalendars())
      if (!calendars.length) throw new Error('no calendars found.')
      const selected = selectCollections(calendars, name, 'calendar')
      const fetchedAt = new Date().toISOString()
      const entries = {}
      for (const calendar of selected) {
        entries[calendar.url] = await client.calendarQuery(calendar.url, startDate, endDate)
      }
      if (cache) {
        try {
          cache.update(calendars, entries, fetchedAt)
        } catch (err) {
          node.warn('Nextcloud:CalDAV -> could not write cache: ' + err.message)
        }
      }
      return selected.map((calendar) => ({ calendar, entries: entries[calendar.url], fetchedAt }))
    }

    function fromCache (name, error) {
      const data = cache.load()
      if (!data) throw new Error(error.message + ' (no cached calendar data yet)')
      const selected = selectCollections(data.calendars, name, 'calendar')
        .filter((calendar) => data.objects[calendar.url])
      if (!selected.length) throw new Error(error.message + ' (calendar not cached yet)')
      return selected.map((calendar) => Object.assign({ calendar }, data.objects[calendar.url]))
    }

    handleInput(node, 'Nextcloud:CalDAV', async function (client, msg, send) {
      const startDate = new Date()
      startDate.setHours(0, 0, 0, 0)
      startDate.setDate(startDate.getDate() - node.pastWeeks * 7)
      const endDate = new Date()
      endDate.setHours(23, 59, 59, 999)
      endDate.setDate(endDate.getDate() + node.futureWeeks * 7)
      const name = msg.calendar || node.calendar

      let results
      let cached = false
      try {
        results = await fetchOnline(client, name, startDate, endDate)
        if (offline) node.log('Nextcloud:CalDAV -> server reachable again')
        offline = false
      } catch (err) {
        if (!cache || !isOffline(err)) throw err
        results = fromCache(name, err)
        cached = true
        if (!offline) node.warn('Nextcloud:CalDAV -> server unreachable (' + err.message + '), using cached calendar data')
        offline = true
      }

      for (const { calendar, entries, fetchedAt } of results) {
        let data = []
        for (const entry of entries) {
          try {
            data = data.concat(expandEvents(entry.data, startDate, endDate))
          } catch (error) {
            node.warn('Nextcloud:CalDAV -> error parsing calendar entry ' + entry.href + ': ' + error.message)
          }
        }
        const out = RED.util.cloneMessage(msg)
        out.payload = { name: calendar.displayName, data: sortEvents(data), fromCache: cached, fetchedAt }
        send(out)
      }

      if (cached) {
        const oldest = results.map((r) => r.fetchedAt).sort()[0]
        return { fill: 'yellow', shape: 'ring', text: 'offline, cache from ' + new Date(oldest).toLocaleString() }
      }
    })

    node.on('close', function (removed, done) {
      if (removed && cache) {
        try { cache.remove() } catch (err) {}
      }
      done()
    })
  }
  RED.nodes.registerType('nextcloud-caldav', NextcloudCalDav)

  function NextcloudCardDav (config) {
    RED.nodes.createNode(this, config)
    this.server = RED.nodes.getNode(config.server)
    this.addressBook = config.addressBook
    const node = this

    handleInput(node, 'Nextcloud:CardDAV', async function (client, msg, send) {
      let addressBooks = await client.listAddressBooks()
      if (!addressBooks.length) throw new Error('no addressbooks found.')
      addressBooks = selectCollections(addressBooks, msg.addressBook || node.addressBook, 'addressbook')

      for (const addressBook of addressBooks) {
        const entries = await client.addressBookQuery(addressBook.url)
        const out = RED.util.cloneMessage(msg)
        out.payload = { name: addressBook.displayName, data: entries.map((e) => parseVCard(e.data)) }
        send(out)
      }
    })
  }
  RED.nodes.registerType('nextcloud-carddav', NextcloudCardDav)

  function NextcloudWebDavList (config) {
    RED.nodes.createNode(this, config)
    this.server = RED.nodes.getNode(config.server)
    this.directory = config.directory
    const node = this

    handleInput(node, 'Nextcloud:WebDAV', async function (client, msg, send) {
      const directory = msg.directory || node.directory || ''
      msg.payload = await client.listDirectory(directory)
      send(msg)
    })
  }
  RED.nodes.registerType('nextcloud-webdav-list', NextcloudWebDavList)

  function NextcloudWebDavOut (config) {
    RED.nodes.createNode(this, config)
    this.server = RED.nodes.getNode(config.server)
    this.filename = config.filename
    const node = this

    handleInput(node, 'Nextcloud:WebDAV', async function (client, msg, send) {
      const filename = msg.filename || node.filename
      if (!filename) throw new Error('no filename specified.')
      msg.payload = await client.getFile(filename)
      send(msg)
    })
  }
  RED.nodes.registerType('nextcloud-webdav-out', NextcloudWebDavOut)

  function NextcloudWebDavIn (config) {
    RED.nodes.createNode(this, config)
    this.server = RED.nodes.getNode(config.server)
    this.directory = config.directory
    this.filename = config.filename
    const node = this

    handleInput(node, 'Nextcloud:WebDAV', async function (client, msg, send) {
      // local file to upload, Windows paths with backslashes are fine as well
      const filename = msg.filename || node.filename
      if (!filename) throw new Error('no filename specified.')
      const name = filename.split(/[\\/]/).pop()
      const file = await fs.promises.readFile(filename)
      const directory = msg.directory || node.directory || ''
      const remotePath = normalizePath(directory + '/' + name)
      const statusCode = await client.putFile(remotePath, file)
      msg.payload = { path: remotePath, size: file.length, statusCode }
      send(msg)
    })
  }
  RED.nodes.registerType('nextcloud-webdav-in', NextcloudWebDavIn)
}
