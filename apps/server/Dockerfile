# syntax=docker/dockerfile:1
# Build context: repository root.
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @zoom3d/server...
COPY packages/shared packages/shared
COPY apps/server apps/server
# One self-contained file: shared code and every dependency are bundled in.
RUN pnpm --filter @zoom3d/server build

FROM node:24-alpine
# CI passes the commit; Sentry tags server errors with it. Set SENTRY_DSN at runtime to turn Sentry on.
ARG GIT_SHA=""
ENV NODE_ENV=production PORT=8787 SENTRY_RELEASE=$GIT_SHA
WORKDIR /app
COPY --from=build /repo/apps/server/dist/server.mjs ./server.mjs
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["node", "server.mjs"]
