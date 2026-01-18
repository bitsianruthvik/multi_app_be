Dev tools and debug helpers

This folder contains development-only utilities and a debug-only Express route.

Files:

- `force_update_route.js` - an Express Router exposing `POST /debug/force_update`.
  - NOTE: This file is intentionally NOT mounted by the main server. To use it
    locally, mount it in a development-only entrypoint with something like:

```js
import forceDev from "./dev-tools/force_update_route.js";
app.use("/api/query/v1", forceDev);
```

- `scripts/` - helper scripts for local debugging (inspect rows, insert test rows,
  run direct pool updates). These are not intended for production.

Security:

- The route requires `WORKER_SERVICE_TOKEN` and is intended for local debugging
  only. Do not mount this in production.

Usage examples:

- List recent rows:
  `node dev-tools/scripts/list_recent_audio.mjs`
- Force update a transcription (local dev only):
  `curl -X POST 'http://localhost:4000/api/query/v1/debug/force_update' \
  -H 'Authorization: Bearer <WORKER_SERVICE_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"id": 123, "transcription":"text"}'`
