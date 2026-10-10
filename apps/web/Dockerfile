# syntax=docker/dockerfile:1
# Build context: repository root.
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @zoom3d/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
# Baked into the bundle; empty (local builds, forks) leaves Sentry and analytics off. Both values are public.
ARG VITE_SENTRY_DSN="" VITE_AMPLITUDE_API_KEY="" VITE_RELEASE=""
RUN pnpm --filter @zoom3d/web build

FROM nginxinc/nginx-unprivileged:stable-alpine
# Upstream for /ws; the image entrypoint renders /etc/nginx/templates/*.template.
ENV SERVER_URL=http://server:8787 \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY apps/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
