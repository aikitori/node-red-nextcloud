# node-red-contrib-nextcloud
Collection of node-red nodes to download Calendars (CalDAV) and Contacts
(CardDAV) and up- / download / list files (WebDAV) from / to [nextcloud](https://nextcloud.com/)

Detailed information can be found in the build in info of each node

## Installation
npm install node-red-contrib-nextcloud

Requires Node.js 18 or newer and Node-RED 2.0 or newer. The nodes talk to Nextcloud with a small
built-in DAV client, the only dependencies are `@xmldom/xmldom` and `ical-expander`.

All nodes keep the properties of the incoming message and report errors with the message, so they
can be handled with a catch node.

### CalDAV
- reads all calendars and sends a message for each calendar
- reads a specified calandar if set in node properties or incoming message (`msg.calendar`)
- only events in the configured range are requested, recurring events are expanded into
  their occurrences
- times are ISO strings in UTC (`2026-10-20T06:00:00.000Z`), all-day events use a plain date
- offline cache (default on): the requested calendars are kept completely in
  `nextcloud-cache/<node id>.json` in the Node-RED user directory, later requests download only the
  changes (sync-token). The node status shows "cached <time>" after a successful request. If Nextcloud cannot be reached, the node answers from this cache
  (`msg.payload.fromCache: true`, `msg.payload.fetchedAt`) and shows a yellow status.
  Wrong credentials are still reported as errors.

### CardDAV
- reads all addressbooks and sends a message for each adressbook
- reads a specified addressbook if set in node properties or incoming message

### WebDAV

##### Read content of a server directory
- reads content of the users root directory if no folder is specified
- reads content of a given directory specified in node properties or incoming message

##### Upload a file to a server directory
- uploads a file to nextcloud server
- absolute path of upload file can be set in node properties or incoming message
- server directory can be set in node properties or incoming message

##### Download a file from a server directory
- downloads a file from nextcloud server
- file on server can be set in node properties or incoming message
- sends file as binary buffer to the output. File can be stored using file node

## Tests
```
npm install
npm test
```
The tests run the nodes in Node-RED against a small mock Nextcloud (`test/mock-nextcloud.js`).
