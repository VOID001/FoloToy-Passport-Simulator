# Deployment

The production site is a small Node.js service because FoloToy community
imports are downloaded and verified by the same-origin server.

## Build

```bash
npm test
npm run build
npm run verify:release
```

`dist/` is the complete release artifact. It contains the browser application,
ESP-EMU runtime, bundled firmware assets, community import proxy, deployment
metadata, and `SHA256SUMS`.

The release server disables local firmware selection by default. Production
users can only load firmware through the server-verified FoloToy community
import flow. Set `EMULATOR_ALLOW_LOCAL_FIRMWARE_UPLOAD=1` only for a trusted
local deployment that explicitly needs local `.bin` files.

## Run The Release

```bash
cd dist
HOST=0.0.0.0 PORT=4190 npm start
```

The health check endpoint is `GET /healthz`.

## Runtime Logs

The server writes one JSON object per line to standard output or standard
error. HTTP requests emit an `http_access` record with a request ID, method,
path, status, response size, client address, and duration. Query strings and
request bodies are intentionally omitted.

Failures emit a separate record using the same `request_id`. Community import
failures include the upstream stage, HTTP status, request ID, retry count, and
`Retry-After` value when those fields are available. WebSocket upgrades and
network bridge connection failures are logged as separate events. WebSocket
acceptance and rejection records include `active_sessions`, `max_sessions`, and
`session_id`. Session close records additionally include `reason` and
`duration_ms`; unresponsive clients first emit
`network_bridge_session_expired` with `reason=heartbeat_timeout`.

Reverse proxies may supply `X-Request-ID`; valid values are returned to the
client and used in all related records. Otherwise, the server generates an ID.

## Embed In An Iframe

The server allows iframe embedding from any parent origin, including local
development pages. It omits CSP `frame-ancestors` and `X-Frame-Options` while
preserving the other security headers. Reverse proxies must not add restrictive
`frame-ancestors` or `X-Frame-Options` headers if embedding should remain available.

```html
<iframe
  src="https://folotoy-passport-simulator.onrender.com/?play=100"
  title="AI Passport 在线试玩"
  allow="microphone; autoplay; fullscreen"
></iframe>
```

The embedding page's own CSP must also permit the simulator in `frame-src`.
Sound still requires a user click, and microphone access requires browser
permission in a secure context. To test before deploying community changes,
temporarily insert the iframe in a community page using browser DevTools, or
use a local preview page. This changes only the test browser's DOM; refreshing
restores the original page. The deployed simulator must include this header
change before remote embedding can work.

## Environment Variables

| Variable | Default | Production recommendation | Description |
| --- | --- | --- | --- |
| `HOST` | `127.0.0.1` | `0.0.0.0` | Address on which the HTTP server listens. |
| `PORT` | `4190` | Platform-provided value | HTTP and WebSocket port. Railway supplies this automatically. |
| `EMULATOR_ALLOW_LOCAL_FIRMWARE_UPLOAD` | Disabled | `0` | Set to `1` only when users should be able to select arbitrary local `.bin` files. |
| `EMULATOR_NETWORK_ALLOW_PRIVATE` | Disabled | `0` | Set to `1` only in a trusted environment to allow emulated firmware to reach private, loopback, and reserved addresses. |
| `EMULATOR_NETWORK_MAX_SESSIONS` | `16` | Tune for the instance size | Maximum concurrent emulator WebSocket sessions. Valid range: 1-256. |
| `EMULATOR_NETWORK_HEARTBEAT_MS` | `30000` | `30000` | WebSocket Ping interval in milliseconds. Valid range: 1000-600000; an unanswered Ping is terminated at the next interval. |

Environment variables take precedence over command-line defaults. The source
development command, `npm start`, passes `--allow-local-firmware-upload`.
The generated `dist/package.json` does not pass that flag, so release
deployments remain fail-closed unless
`EMULATOR_ALLOW_LOCAL_FIRMWARE_UPLOAD=1` is explicitly configured.

Recommended Railway variables:

```env
HOST=0.0.0.0
EMULATOR_ALLOW_LOCAL_FIRMWARE_UPLOAD=0
EMULATOR_NETWORK_ALLOW_PRIVATE=0
EMULATOR_NETWORK_MAX_SESSIONS=16
EMULATOR_NETWORK_HEARTBEAT_MS=30000
```

Do not set `PORT` on Railway unless the platform configuration specifically
requires it. Railway injects `PORT` for the service.

`EMULATOR_ALLOW_LOCAL_FIRMWARE_UPLOAD` controls the product UI and local file
handling path. It is not authentication for `/api/emulator-network`. Keep the
network bridge protected by its destination restrictions and by access control
at the deployment or reverse-proxy layer.

For Render deployments, the CLI can query the session lifecycle directly:

```bash
render logs --resources <service-id> --type app --text websocket_access
render logs --resources <service-id> --type app --text network_bridge_session_closed
render logs --resources <service-id> --type app --text network_bridge_session_expired
```

Compare accepted sessions (`status=101`) with close events by `session_id`.
Capacity rejections use `status=503`, `reason=session_limit`, and report both the
active and maximum session counts.

## Docker

```bash
docker build -t folotoy-passport-simulator .
docker run --rm -p 4190:4190 folotoy-passport-simulator
```

Terminate TLS at the reverse proxy and forward requests to port `4190`.
The server emits the cross-origin isolation headers required by the WASM
runtime and restricts community imports to published firmware from
`https://ai-passport.folotoy.cn`.
