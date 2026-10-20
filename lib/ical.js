'use strict'
const IcalExpander = require('ical-expander')

// Upper bound for recurrence iterations per series. Expansion stops at the end of the
// requested range anyway, this only protects against pathological rules.
const MAX_ITERATIONS = 100000

function formatTime (t) {
  // all-day values stay plain dates (e.g. 2026-10-23), timed values become UTC ISO strings
  return t.isDate ? t.toString() : t.toJSDate().toISOString()
}

function stripMailto (v) {
  return typeof v === 'string' ? v.replace(/^mailto:/i, '') : v
}

function convertAttendee (prop) {
  return {
    name: prop.getParameter('cn') || '',
    email: stripMailto(prop.getFirstValue()) || '',
    role: prop.getParameter('role') || '',
    status: prop.getParameter('partstat') || ''
  }
}

// item: ICAL.Event, start/end: ICAL.Time of this instance, recurrenceId: ICAL.Time or null
function convertEvent (item, start, end, recurrenceId) {
  const duration = end.subtractDate(start)
  return {
    startDate: formatTime(start),
    endDate: formatTime(end),
    summary: item.summary || '',
    description: item.description || '',
    attendees: item.attendees.map(convertAttendee),
    duration: duration.toICALString(),
    durationSeconds: duration.toSeconds(),
    location: item.location || '',
    organizer: item.organizer || '',
    uid: item.uid || '',
    isRecurring: !!recurrenceId,
    recurrenceId: recurrenceId ? formatTime(recurrenceId) : null,
    allDay: !!start.isDate
  }
}

// Expands one iCalendar object into the event instances overlapping [start, end]
function expandEvents (ics, start, end) {
  const expander = new IcalExpander({ ics, maxIterations: MAX_ITERATIONS })
  const result = expander.between(start, end)
  const events = result.events.map((e) => convertEvent(e, e.startDate, e.endDate, e.recurrenceId))
  const occurrences = result.occurrences.map((o) => convertEvent(o.item, o.startDate, o.endDate, o.recurrenceId))
  return events.concat(occurrences)
}

function sortEvents (events) {
  const time = (e) => new Date(e.startDate).getTime()
  return events.sort((a, b) => time(a) - time(b))
}

// Flat key/value view of a vCard as before ("FN": "...", "TEL;TYPE=cell": "..."),
// but with unfolded lines and values that may contain ':'
function parseVCard (data) {
  const card = {}
  const lines = data.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  for (const line of lines) {
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    card[line.slice(0, idx)] = line.slice(idx + 1)
  }
  return card
}

module.exports = { expandEvents, sortEvents, parseVCard, MAX_ITERATIONS }
