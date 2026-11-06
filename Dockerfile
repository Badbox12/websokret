# Real-time chat API (Bun + Elysia + MongoDB)
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Production deps only (skips typescript, bun-types)
RUN bun install --frozen-lockfile --production

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# Hosts like Render inject PORT; the app reads it (defaults to 3000)
EXPOSE 3000
USER bun
CMD ["bun", "src/index.ts"]
