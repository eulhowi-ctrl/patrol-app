# 1GB RAM Oracle Free Tier 인스턴스 대상: 빌드 단계에서 메모리 상한을 낮춰 OOM을 방지한다.
# (infra/setup-infrastructure.sh 가 만든 2GB swap과 함께 사용)

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev=false

FROM node:20-alpine AS builder
WORKDIR /app
ENV NODE_OPTIONS="--max-old-space-size=512"
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=256"
RUN addgroup -S patrol && adduser -S patrol -G patrol
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
USER patrol
EXPOSE 3000
CMD ["npm", "run", "start"]
