'use strict'
process.env.TZ = 'Europe/Berlin'
const test = require('node:test')
const assert = require('node:assert')
const { expandEvents, parseVCard, outside } = require('../lib/ical')
const { toCalDavTime } = require('../lib/dav')
const { calendar, dailyStandup, vcard } = require('./fixtures')

test('daily series started long ago is expanded into the range', () => {
  const events = expandEvents(dailyStandup, new Date('2026-10-20T00:00:00+02:00'), new Date('2026-10-27T23:59:59+01:00'))
  assert.strictEqual(events.length, 8)
  const first = events.find((e) => e.startDate === '2026-10-20T06:00:00.000Z')
  assert.ok(first, 'occurrence on 2026-10-20 08:00 Berlin')
  assert.strictEqual(first.endDate, '2026-10-20T06:30:00.000Z')
  assert.strictEqual(first.isRecurring, true)
  assert.strictEqual(first.recurrenceId, '2026-10-20T06:00:00.000Z')
  assert.strictEqual(first.allDay, false)
  assert.strictEqual(first.durationSeconds, 1800)
  assert.deepStrictEqual(first.attendees, [{ name: 'Anna', email: 'anna@example.org', role: 'REQ-PARTICIPANT', status: 'ACCEPTED' }])
  // after the switch to winter time the local time stays 08:00
  assert.ok(events.find((e) => e.startDate === '2026-10-26T07:00:00.000Z'))
})

test('all-day detection uses the date type, not the duration', () => {
  const ics = calendar([
    'BEGIN:VEVENT', 'UID:a', 'DTSTAMP:20250101T000000Z',
    'DTSTART;TZID=Europe/Berlin:20261021T100000', 'DTEND;TZID=Europe/Berlin:20261022T100000',
    'SUMMARY:24h', 'END:VEVENT'
  ], [
    'BEGIN:VEVENT', 'UID:b', 'DTSTAMP:20250101T000000Z',
    'DTSTART;VALUE=DATE:20261023', 'DTEND;VALUE=DATE:20261024', 'SUMMARY:day', 'END:VEVENT'
  ])
  const events = expandEvents(ics, new Date('2026-10-20T00:00:00'), new Date('2026-10-27T00:00:00'))
  const timed = events.find((e) => e.uid === 'a')
  const day = events.find((e) => e.uid === 'b')
  assert.strictEqual(timed.allDay, false)
  assert.strictEqual(timed.startDate, '2026-10-21T08:00:00.000Z')
  assert.strictEqual(timed.isRecurring, false)
  assert.strictEqual(day.allDay, true)
  assert.strictEqual(day.startDate, '2026-10-23')
  assert.strictEqual(day.endDate, '2026-10-24')
})

test('recurrence exceptions replace the regular occurrence', () => {
  const ics = calendar([
    'BEGIN:VEVENT', 'UID:r', 'DTSTAMP:20250101T000000Z',
    'DTSTART;TZID=Europe/Berlin:20261019T090000', 'DTEND;TZID=Europe/Berlin:20261019T100000',
    'RRULE:FREQ=DAILY;COUNT=5', 'EXDATE;TZID=Europe/Berlin:20261022T090000', 'SUMMARY:Series', 'END:VEVENT'
  ], [
    'BEGIN:VEVENT', 'UID:r', 'DTSTAMP:20250101T000000Z', 'RECURRENCE-ID;TZID=Europe/Berlin:20261021T090000',
    'DTSTART;TZID=Europe/Berlin:20261021T140000', 'DTEND;TZID=Europe/Berlin:20261021T150000',
    'SUMMARY:Moved', 'END:VEVENT'
  ])
  const events = expandEvents(ics, new Date('2026-10-19T00:00:00'), new Date('2026-10-31T00:00:00'))
  assert.deepStrictEqual(events.map((e) => e.summary).sort(), ['Moved', 'Series', 'Series', 'Series'])
  const moved = events.find((e) => e.summary === 'Moved')
  assert.strictEqual(moved.startDate, '2026-10-21T12:00:00.000Z')
  assert.strictEqual(moved.isRecurring, true)
})

test('vcard values keep colons and folded lines', () => {
  const card = parseVCard(vcard)
  assert.strictEqual(card.FN, 'Anna Example')
  assert.strictEqual(card.URL, 'https://example.org/anna')
  assert.strictEqual(card.NOTE, 'a long note that is folded over two lines')
  assert.strictEqual(card['TEL;TYPE=cell'], '+49 151 000000')
})

test('CalDAV time-range is sent in UTC', () => {
  assert.strictEqual(toCalDavTime(new Date('2026-10-20T00:00:00+02:00')), '20261019T220000Z')
})

test('events clearly outside the range are skipped before parsing', () => {
  const start = new Date('2026-10-20T00:00:00+02:00')
  const end = new Date('2026-10-27T23:59:59+01:00')
  const single = (from, to) => calendar(['BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20250101T000000Z',
    'DTSTART;TZID=Europe/Berlin:' + from, 'DTEND;TZID=Europe/Berlin:' + to, 'SUMMARY:x', 'END:VEVENT'])
  assert.strictEqual(outside(single('20200101T100000', '20200101T110000'), start, end), true, 'long ago')
  assert.strictEqual(outside(single('20300101T100000', '20300101T110000'), start, end), true, 'far ahead')
  assert.strictEqual(outside(single('20261017T100000', '20261017T110000'), start, end), false, 'margin before start')
  assert.strictEqual(outside(single('20261021T100000', '20261021T110000'), start, end), false, 'inside')
  assert.strictEqual(outside(single('20200101T100000', '20301231T110000'), start, end), false, 'spans the range')
  assert.strictEqual(outside(dailyStandup, start, end), false, 'recurring')
})
