# ============================================================
#  MedBook India — Production Dockerfile
#  Multi-stage build: compile TypeScript → lean production image
# ============================================================

# ── Stage 1: Build ────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (cached unless package.json changes)
COPY package.json package-lock.json ./
RUN npm ci --frozen-lockfile

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# ── Stage 2: Production ───────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Security: run as non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S medbook -u 1001

# Copy only what's needed for production
COPY package.json package-lock.json ./
RUN npm ci --frozen-lockfile --omit=dev && npm cache clean --force

# Copy compiled JS
COPY --from=builder /app/dist ./dist

# Copy schema files (for documentation / migration scripts)
COPY schema/ ./schema/

# Create logs directory
RUN mkdir -p logs && chown medbook:nodejs logs

# Switch to non-root user
USER medbook

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Start
CMD ["node", "dist/index.js"]
