# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: compile the TypeScript sources with the native type checker.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime stage: no dependencies to install, no build tools, non-root user.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node --from=build /app/dist ./dist

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/src/index.js"]
