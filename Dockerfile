FROM node:22-alpine AS build
# better-sqlite3 is a native module; toolchain needed when no prebuilt binary matches
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
# BODY_SIZE_LIMIT: adapter-node caps request bodies at 512K by default, far
# below the attachment limits the app advertises (5 MB images, 25 MB documents).
# 32M leaves headroom for multipart overhead.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    BODY_SIZE_LIMIT=32M
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/drizzle ./drizzle
COPY package.json ./
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "build"]
