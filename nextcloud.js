module.exports = function (RED) {
  const fs = require('fs')
  const { NextcloudClient, normalizePath } = require('./lib/dav')
  const { expandEvents, sortEvents, parseVCard } = require('./lib/ical')

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

  // Wraps an async input handler: errors go to done() (catch node), status shows progress
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
        .then(() => {
          node.status({})
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
    const node = this

    handleInput(node, 'Nextcloud:CalDAV', async function (client, msg, send) {
      const startDate = new Date()
      startDate.setHours(0, 0, 0, 0)
      startDate.setDate(startDate.getDate() - node.pastWeeks * 7)
      const endDate = new Date()
      endDate.setHours(23, 59, 59, 999)
      endDate.setDate(endDate.getDate() + node.futureWeeks * 7)

      let calendars = await client.listCalendars()
      // only calendars that can hold events (skips task lists)
      calendars = calendars.filter((c) => !c.components.length || c.components.includes('VEVENT'))
      if (!calendars.length) throw new Error('no calendars found.')
      calendars = selectCollections(calendars, msg.calendar || node.calendar, 'calendar')

      for (const calendar of calendars) {
        const entries = await client.calendarQuery(calendar.url, startDate, endDate)
        let data = []
        for (const entry of entries) {
          try {
            data = data.concat(expandEvents(entry.data, startDate, endDate))
          } catch (error) {
            node.warn('Nextcloud:CalDAV -> error parsing calendar entry ' + entry.href + ': ' + error.message)
          }
        }
        const out = RED.util.cloneMessage(msg)
        out.payload = { name: calendar.displayName, data: sortEvents(data) }
        send(out)
      }
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
