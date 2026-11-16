# stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

# stage 2: Run
FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Port
EXPOSE 4000

CMD ["node", "dist/server.js"]