FROM node:20-alpine

# better-sqlite3 needs build tools
RUN apk add --no-cache python3 make g++ openssl

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy app
COPY . .

# Create data directory
RUN mkdir -p data

# Generate self-signed cert (fallback if Coolify doesn't terminate SSL)
RUN openssl req -new -x509 -newkey rsa:2048 -nodes \
    -keyout data/.cert-key.pem -out data/.cert.pem \
    -days 3650 -subj "/CN=localhost" 2>/dev/null || true

EXPOSE 3000

ENV NODE_ENV=production
ENV TRUST_PROXY=true

# Data directory should be mounted as a volume for persistence
VOLUME ["/app/data"]

CMD ["node", "server.js"]
