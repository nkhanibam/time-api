// netlify/functions/time.js

function unauthorized() {
  return {
    statusCode: 401,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    },
    body: JSON.stringify({ error: "Unauthorized" })
  };
}

exports.handler = async (event) => {
  // Allow only GET (optional but good hygiene)
  if (event.httpMethod && event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Method Not Allowed" })
    };
  }

  // Require API key from environment
  const requiredKey = process.env.TIME_API_KEY;
  if (!requiredKey) {
    // Fail closed: safer than accidentally running an open public endpoint
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Server not configured (TIME_API_KEY missing)." })
    };
  }

  // Netlify normalizes headers to lowercase
  const gotKey =
    event.headers?.["x-time-key"] ||
    event.headers?.["authorization"]?.replace(/^Bearer\s+/i, "") ||
    "";

  if (gotKey !== requiredKey) return unauthorized();

  // Compute Toronto local time
  const now = new Date();
  const tz = "America/Toronto";

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(now);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));

  const datetime = `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}`;

  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      // Time changes constantly; allow minimal caching
      "cache-control": "public, max-age=1"
    },
    body: JSON.stringify({ datetime })
  };
};
