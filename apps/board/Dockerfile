# syntax=docker/dockerfile:1
# Build context is the Snoboard workspace root (this repository).

FROM node:24.18.0-slim AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /src

RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/board/package.json apps/board/package.json
RUN pnpm install --frozen-lockfile

COPY packages/core packages/core
COPY apps/board apps/board
RUN pnpm --filter snoboard build \
 && pnpm --filter @snoboard/board build \
 && pnpm --filter @snoboard/board deploy --legacy --prod /prod/board \
 && cp -a /src/apps/board/dist /prod/board/dist \
 && node apps/board/prune-runtime.mjs /prod/board \
 && test -f /prod/board/dist/server/index.mjs

FROM node:24.18.0-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
 && rm -rf /var/lib/apt/lists/* \
    /usr/share/perl /usr/share/perl5 \
    /usr/lib/*/perl /usr/lib/*/perl5 /usr/lib/*/perl-base \
    /usr/lib/*/libperl.so* \
    /usr/bin/perl /usr/bin/perl5* \
    /usr/share/doc /usr/share/man /usr/share/info \
 && git config --system --add safe.directory '*' \
 && groupadd --gid 10001 snoboard \
 && useradd --uid 10001 --gid 10001 --home-dir /home/snoboard --create-home --shell /usr/sbin/nologin snoboard

WORKDIR /app
COPY --from=build --chown=10001:10001 /prod/board/node_modules /app/apps/board/node_modules
COPY --from=build --chown=10001:10001 /prod/board/package.json /app/apps/board/package.json
COPY --from=build --chown=10001:10001 /src/apps/board/dist /app/apps/board/dist

# Optional: --build-arg SNOBOARD_VERSION=<image tag>. Empty falls back to the package version;
# the Helm charts also set it from image.tag at runtime.
ARG SNOBOARD_VERSION=""
LABEL org.opencontainers.image.version="${SNOBOARD_VERSION}"

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    SNOBOARD_VERSION=${SNOBOARD_VERSION}

EXPOSE 8080
USER 10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'8080')+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "apps/board/dist/server/index.mjs"]
