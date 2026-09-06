FROM node:22-alpine AS build

WORKDIR /src
COPY package.json server.mjs community-import.mjs network-bridge.mjs network-packets.mjs README.md DEPLOYMENT.md ./
COPY public ./public
COPY tools/build-site.mjs tools/verify-board-runtime.mjs tools/verify-site.mjs ./tools/
RUN npm run build && node tools/verify-site.mjs

FROM node:22-alpine

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4190

WORKDIR /app
COPY --from=build --chown=node:node /src/dist/ ./

USER node
EXPOSE 4190
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4190/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server.mjs"]
