FROM node:22.12.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json vite.config.ts index.html .nvmrc README.md Makefile ./
COPY src ./src
COPY api ./api
COPY test ./test
COPY examples ./examples
RUN npm run build

FROM node:22.12.0-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY --from=build /app/examples ./examples

USER node
CMD ["node", "dist/src/server/main.js"]
