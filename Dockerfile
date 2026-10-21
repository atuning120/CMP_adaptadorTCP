# ---- Build: compila TypeScript con todas las dependencias ----
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# ---- Runtime: solo dist y dependencias de producción ----
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    TCP_PORT=5023

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

USER node
# 3001: HTTP (/health). 5023: TCP de los dispositivos GT06
EXPOSE 3001 5023
CMD ["node", "dist/main.js"]
