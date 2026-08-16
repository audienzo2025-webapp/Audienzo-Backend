/** Calendar-day helpers for upcoming/past events and registration deadlines. */

function startOfCalendarDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseCalendarDate(dateStr) {
  if (!dateStr || !String(dateStr).trim()) return null;
  const raw = String(dateStr).trim();
  const datePart = raw.split('T')[0];
  const parts = datePart.split('-').map((p) => parseInt(p, 10));
  if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function getEventEndDateStr(event) {
  const end = event?.endDate || event?.startDate;
  return end ? String(end) : null;
}

function isEventUpcoming(event, today = startOfCalendarDay()) {
  const endDay = parseCalendarDate(getEventEndDateStr(event));
  if (!endDay) return false;
  return today.getTime() <= endDay.getTime();
}

function isEventPast(event, today = startOfCalendarDay()) {
  const endDay = parseCalendarDate(getEventEndDateStr(event));
  if (!endDay) return false;
  return today.getTime() > endDay.getTime();
}

function isRegistrationDeadlinePassed(deadlineStr, today = startOfCalendarDay()) {
  const deadlineDay = parseCalendarDate(deadlineStr);
  if (!deadlineDay) return false;
  return today.getTime() > deadlineDay.getTime();
}

module.exports = {
  startOfCalendarDay,
  parseCalendarDate,
  getEventEndDateStr,
  isEventUpcoming,
  isEventPast,
  isRegistrationDeadlinePassed
};
