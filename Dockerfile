FROM node:22-alpine AS base

# Install curl (required for FreeGPT WASM proxy) and other native deps
RUN apk add --no-cache curl openssl libc6-compat

WORKDIR /app

# ─── Dependencies ──────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

# ─── Builder ───────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build Next.js (outputs standalone + static)
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build

# ─── Runner ────────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone build
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy WASM signer files (required for FreeGPT provider)
COPY --from=builder /app/wasm_signer_bg.wasm ./wasm_signer_bg.wasm
COPY --from=builder /app/wasm_signer.js ./wasm_signer.js
COPY --from=builder /app/src/lib/freegpt-signer.cjs ./src/lib/freegpt-signer.cjs

RUN chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]