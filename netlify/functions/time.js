// netlify/functions/time.js

function unauthorized() {
  return {
    statusCode: 401,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ error: "Unauthorized" }),
  };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Build "YYYY-MM-DDTHH:mm:ss.ffffff" (microseconds; JS only has milliseconds, so we append 000)
function formatIsoLocalWithMicros(parts) {
  const ms = parts.millisecond ?? "000";
  const micros = `${ms}000`; // ms -> microseconds (best possible without Temporal)
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${micros}`;
}

// Get local parts for a given timezone at a given Date
function getZonedParts(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = dtf.formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));

  // Milliseconds from Date (not tz-dependent)
  map.millisecond = String(date.getMilliseconds()).padStart(3, "0");
  return map;
}

// Offset in seconds for tz at date.
// Uses timeZoneName: 'shortOffset' if available; falls back to calculation.
function getOffsetSeconds(date, tz) {
  // Try modern Intl offset token: "GMT-5" / "GMT-05:00"
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(date);
    const tzPart = parts.find((p) => p.type === "timeZoneName")?.value || "";
    // tzPart like "GMT-5" or "GMT-05:00"
    const m = tzPart.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
    if (m) {
      const sign = m[1] === "-" ? -1 : 1;
      const hh = Number(m[2]);
      const mm = Number(m[3] || "0");
      return sign * (hh * 3600 + mm * 60);
    }
  } catch (_) {
    // ignore
  }

  // Fallback: compute offset by comparing "wall time in tz" to UTC
  const p = getZonedParts(date, tz);
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
    Number(p.millisecond)
  );
  const actualUtc = date.getTime();
  // local wall time interpreted as UTC minus actual UTC = offset
  return Math.round((asUtc - actualUtc) / 1000);
}

function offsetToUtcOffsetString(offsetSeconds) {
  const sign = offsetSeconds >= 0 ? "+" : "-";
  const abs = Math.abs(offsetSeconds);
  const hh = Math.floor(abs / 3600);
  const mm = Math.floor((abs % 3600) / 60);
  return `${sign}${pad2(hh)}:${pad2(mm)}`;
}

// ISO weekday: Monday=1 ... Sunday=7
function isoWeekday(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const js = d.getUTCDay(); // 0=Sun..6=Sat
  return js === 0 ? 7 : js;
}

function dayOfYear(year, month, day) {
  const start = Date.UTC(year, 0, 1);
  const cur = Date.UTC(year, month - 1, day);
  return Math.floor((cur - start) / 86400000) + 1;
}

// ISO week number (weeks start Monday, week 1 has Jan 4th)
function isoWeekNumber(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  // Thursday in current week determines week-year
  const weekday = isoWeekday(year, month, day);
  date.setUTCDate(date.getUTCDate() + (4 - weekday));
  const weekYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const diffDays = Math.floor((date - yearStart) / 86400000);
  return Math.floor(diffDays / 7) + 1;
}

function getAbbreviation(date, tz) {
  // "EST"/"EDT" style (best-effort; depends on runtime locale data)
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(date);
    return parts.find((p) => p.type === "timeZoneName")?.value || "";
  } catch {
    return "";
  }
}

// Find nearest transitions (dst_from / dst_until) by scanning +/- ~370 days and then binary searching to minute.
function findTransitions(now, tz) {
  const nowOffset = getOffsetSeconds(now, tz);

  // helper: offset at UTC timestamp
  const offAt = (t) => getOffsetSeconds(new Date(t), tz);

  const MS_HOUR = 3600000;
  const MS_DAY = 86400000;

  // scan at noon UTC each day (reduces edge weirdness)
  const noon = (t) => {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0, 0);
  };

  let prevChange = null;
  let nextChange = null;

  // Look back up to 370 days
  let lastOff = offAt(noon(now.getTime()));
  for (let i = 1; i <= 370; i++) {
    const t = noon(now.getTime() - i * MS_DAY);
    const o = offAt(t);
    if (o !== lastOff) {
      // transition occurred between t and t+1day (relative to scan direction)
      prevChange = { a: t, b: t + MS_DAY, from: o, to: lastOff };
      break;
    }
    lastOff = o;
  }

  // Look forward up to 370 days
  lastOff = offAt(noon(now.getTime()));
  for (let i = 1; i <= 370; i++) {
    const t = noon(now.getTime() + i * MS_DAY);
    const o = offAt(t);
    if (o !== lastOff) {
      // transition between t-1day and t
      nextChange = { a: t - MS_DAY, b: t, from: lastOff, to: o };
      break;
    }
    lastOff = o;
  }

  // Binary search transition window to minute precision
  const refine = (win) => {
    if (!win) return null;
    let lo = win.a;
    let hi = win.b;
    const targetFrom = offAt(lo);
    const targetTo = offAt(hi);

    // If endpoints don't differ, can't refine.
    if (targetFrom === targetTo) return null;

    while (hi - lo > MS_HOUR / 60) { // > 1 minute
      const mid = Math.floor((lo + hi) / 2);
      const o = offAt(mid);
      if (o === targetFrom) lo = mid;
      else hi = mid;
    }
    // hi is near first moment of new offset
    return new Date(hi);
  };

  const prev = refine(prevChange);
  const next = refine(nextChange);

  // worldtimeapi uses nulls when unknown; we return ISO string in UTC with +00:00
  const toUtcString = (d) =>
    d ? d.toISOString().replace("Z", "+00:00").replace(/\.(\d{3})Z?/, ".$1000+00:00") : null;

  // Determine dst_from/dst_until in terms of the CURRENT DST season:
  // If currently in DST, dst_from is last shift into DST, dst_until is next shift out.
  // If not in DST, dst_from is last shift out, dst_until is next shift in.
  const rawJan = getOffsetSeconds(new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 12)), tz);
  const rawJul = getOffsetSeconds(new Date(Date.UTC(now.getUTCFullYear(), 6, 1, 12)), tz);
  const raw = Math.min(rawJan, rawJul);
  const dstOffset = nowOffset - raw;
  const inDst = dstOffset !== 0;

  // With our limited info, best-effort assignment:
  // - if inDst: prev transition likely dst_from, next likely dst_until
  // - else: prev likely dst_until, next likely dst_from
  return {
    dst_from: inDst ? toUtcString(prev) : toUtcString(next),
    dst_until: inDst ? toUtcString(next) : toUtcString(prev),
  };
}

function getClientIp(event) {
  const xf = event.headers?.["x-forwarded-for"];
  if (xf) return xf.split(",")[0].trim();

  // Netlify sometimes provides these:
  return (
    event.headers?.["x-nf-client-connection-ip"] ||
    event.headers?.["client-ip"] ||
    null
  );
}

exports.handler = async (event) => {
  // --- Auth (same as you have now) ---
  const requiredKey = process.env.TIME_API_KEY;
  if (!requiredKey) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Server not configured (TIME_API_KEY missing)." }),
    };
  }

  const gotKey =
    event.headers?.["x-time-key"] ||
    event.headers?.["authorization"]?.replace(/^Bearer\s+/i, "") ||
    "";

  if (gotKey !== requiredKey) return unauthorized();

  // --- Timezone (hardcode Toronto; safest) ---
  const tz = "America/Toronto";

  const now = new Date();
  const utcOffsetSeconds = getOffsetSeconds(now, tz);
  const utcOffset = offsetToUtcOffsetString(utcOffsetSeconds);

  const p = getZonedParts(now, tz);
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);

  const datetimeLocal = formatIsoLocalWithMicros(p) + utcOffset;

  // UTC datetime with +00:00 and microseconds
  const utcParts = {
    year: now.getUTCFullYear(),
    month: pad2(now.getUTCMonth() + 1),
    day: pad2(now.getUTCDate()),
    hour: pad2(now.getUTCHours()),
    minute: pad2(now.getUTCMinutes()),
    second: pad2(now.getUTCSeconds()),
    millisecond: String(now.getUTCMilliseconds()).padStart(3, "0"),
  };
  const utc_datetime =
    formatIsoLocalWithMicros(utcParts).replace(/\.(\d{6})$/, ".$1") + "+00:00";

  const unixtime = Math.floor(now.getTime() / 1000);

  // raw_offset/dst_offset heuristic (works correctly for Toronto and most zones with 1h DST)
  const rawJan = getOffsetSeconds(new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 12)), tz);
  const rawJul = getOffsetSeconds(new Date(Date.UTC(now.getUTCFullYear(), 6, 1, 12)), tz);
  const raw_offset = Math.min(rawJan, rawJul);
  const dst_offset = utcOffsetSeconds - raw_offset;
  const dst = dst_offset !== 0;

  const abbreviation = getAbbreviation(now, tz);

  const { dst_from, dst_until } = findTransitions(now, tz);
  const client_ip = getClientIp(event);

  const body = {
    utc_offset,
    timezone: tz,
    day_of_week: isoWeekday(year, month, day),
    day_of_year: dayOfYear(year, month, day),
    datetime: datetimeLocal,
    utc_datetime,
    unixtime,
    raw_offset,
    week_number: isoWeekNumber(year, month, day),
    dst,
    abbreviation,
    dst_offset,
    dst_from: dst_from ?? null,
    dst_until: dst_until ?? null,
    client_ip,
  };

  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=1",
    },
    body: JSON.stringify(body),
  };
};
