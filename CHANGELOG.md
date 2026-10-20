# node-red-contrib-nextcloud changelog

## 0.2.0
_2026-10-20_
* replaced the unmaintained `dav` and `webdav` 1.x packages with a small built-in DAV client
  (node `http`/`https`); removes all known vulnerabilities (`xmldom`, `url-parse`, `node-fetch`, ...)
* CalDAV
  * recurring events that started more than 100 occurrences ago were missing, now expanded correctly
  * the time range was sent as local time marked as UTC, now converted to UTC
  * calendars are no longer downloaded completely, only one filtered query per calendar
  * "Accept self signed certificates" now also works for CalDAV and CardDAV
  * **changed output:** `startDate` / `endDate` are ISO times in UTC (all-day events: plain date),
    `allDay` is taken from the event instead of guessed from the duration,
    `attendees` is an array of `{name, email, role, status}`,
    `isRecurring` / `recurrenceId` are set for occurrences of a series, entries are sorted by start
  * task lists (calendars without events) are skipped, an unknown calendar name is reported as error
  * default for "Upcoming weeks" in the editor fixed
* CardDAV: values containing `:` (URLs) and folded lines are parsed completely
* WebDAV upload no longer crashes Node-RED after a successful upload, output is
  `{path, size, statusCode}`; Windows paths and a missing local file are handled
* all nodes keep the incoming message (e.g. for http in / http response) and report errors with the
  message, so catch nodes work; the node status shows running requests and errors
* user names with special characters and server addresses with trailing slash or subdirectory work
* tests against a mock Nextcloud (`npm test`)

## 0.1.3
_2019-08-04_
* security fixes and package updates

## 0.1.2
_2018-11-11_
* merged pull request
 * fixed errors parsing caldav events
 * switched to ical-expander parser

## 0.1.1
_2018-05-01
* added checkbox to accept self signed server certificates to credentials
* added support for self signed certificates to WebDAV nodes (needs [webdav](https://github.com/perry-mitchell/webdav-client) package to be updated to 1.5.3 or newer)
* removed debug output in node WebDAV list

## 0.1.0
_2018-04-30_
* addad missing option to set directory in incoming message for WebDAV list
* published to npm

## 0.0.1
_2018-04-29_

* Initial version
  * CalDAV Node (simple download of calendar entries (ics), no sync, no upload)
  * CardDAV Node (simple download of addressbook entries (vcf), no sync, no upload)
  * WebDAV Nodes
    * List directory entries
    * upload file to nextcloud server
    * download file to nextcloud server
