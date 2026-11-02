# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.3 AS deps
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile

FROM deps AS dev
COPY src ./src
ENV APP_ENV=development HOST=0.0.0.0 PORT=3005
EXPOSE 3005
CMD ["bun", "run", "dev"]

FROM deps AS builder
COPY src ./src
RUN bun run build

FROM oven/bun:1.4.3 AS prod
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3005
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist
EXPOSE 3005
CMD ["bun", "run", "start"]
