FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
RUN npm ci

COPY apps/api ./apps/api
RUN npm run -w api prisma:generate && npm run -w api build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/prisma ./apps/api/prisma
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm run -w api prisma:generate \
    && npm cache clean --force

COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/public ./apps/api/public
COPY docs ./docs
COPY apps/print-agent/prebuilt ./apps/print-agent/prebuilt
RUN mkdir -p /app/data /app/storage/backups

EXPOSE 3000
CMD ["npm", "run", "-w", "api", "start"]
