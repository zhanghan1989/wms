FROM node:22-alpine AS base
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
RUN npm ci

COPY . .
RUN npm run -w api prisma:generate
RUN npm run -w api build

EXPOSE 3000
CMD ["npm", "run", "-w", "api", "start"]
