
FROM node:18-bookworm AS builder

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install --production && \
    npm rebuild sqlite3 --build-from-source && \
    npm cache clean --force

FROM node:18-bookworm-slim

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./

COPY . .

EXPOSE 3000
CMD ["npm", "start"]