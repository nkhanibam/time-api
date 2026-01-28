# Time API (Toronto)

A tiny protected endpoint for current datetime in America/Toronto.

## Endpoint
GET /.netlify/functions/time

## Auth
Send either:
- X-Time-Key: <TIME_API_KEY>
or
- Authorization: Bearer <TIME_API_KEY>

## Response
{ "datetime": "YYYY-MM-DDTHH:mm:ss" }
