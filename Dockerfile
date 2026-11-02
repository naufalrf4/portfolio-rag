# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.3 AS builder
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
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
