FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/pturner1989/scs-couch" \
      org.opencontainers.image.description="An SCS MCP server that keeps SDD artifacts in CouchDB" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
