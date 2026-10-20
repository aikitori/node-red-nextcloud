'use strict'
const VTIMEZONE = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'END:DAYLIGHT',
  'END:VTIMEZONE'
]

function calendar (...events) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...VTIMEZONE, ...events.flat(), 'END:VCALENDAR'].join('\r\n')
}

function ymd (date) {
  const pad = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate())
}

function inDays (n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d
}

// daily series that started long ago, more than 100 occurrences before today
const dailyStandup = calendar([
  'BEGIN:VEVENT', 'UID:daily', 'DTSTAMP:20250101T000000Z',
  'DTSTART;TZID=Europe/Berlin:20250101T080000', 'DTEND;TZID=Europe/Berlin:20250101T083000',
  'RRULE:FREQ=DAILY', 'SUMMARY:Daily standup',
  'ORGANIZER;CN=Bob:mailto:bob@example.org',
  'ATTENDEE;CN=Anna;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:anna@example.org',
  'END:VEVENT'
])

function upcoming () {
  return calendar([
    'BEGIN:VEVENT', 'UID:timed24', 'DTSTAMP:20250101T000000Z',
    'DTSTART;TZID=Europe/Berlin:' + ymd(inDays(1)) + 'T100000',
    'DTEND;TZID=Europe/Berlin:' + ymd(inDays(2)) + 'T100000',
    'SUMMARY:24h timed', 'END:VEVENT'
  ], [
    'BEGIN:VEVENT', 'UID:allday', 'DTSTAMP:20250101T000000Z',
    'DTSTART;VALUE=DATE:' + ymd(inDays(3)), 'DTEND;VALUE=DATE:' + ymd(inDays(4)),
    'SUMMARY:All day', 'END:VEVENT'
  ])
}

const vcard = [
  'BEGIN:VCARD', 'VERSION:3.0', 'UID:c1', 'FN:Anna Example',
  'URL:https://example.org/anna',
  'NOTE:a long note that is folded',
  '  over two lines',
  'TEL;TYPE=cell:+49 151 000000', 'END:VCARD'
].join('\r\n')

module.exports = { calendar, dailyStandup, upcoming, vcard, ymd, inDays }
