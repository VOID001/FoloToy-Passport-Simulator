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

## Run The Release

```bash
cd dist
HOST=0.0.0.0 PORT=4190 npm start
```

The health check endpoint is `GET /healthz`.

## Docker

```bash
docker build -t folotoy-passport-simulator .
docker run --rm -p 4190:4190 folotoy-passport-simulator
```

Terminate TLS at the reverse proxy and forward requests to port `4190`.
The server emits the cross-origin isolation headers required by the WASM
runtime and restricts community imports to published firmware from
`https://ai-passport.folotoy.cn`.
