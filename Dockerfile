FROM node:22-bookworm-slim

# ffmpeg: grab frames from RTSP cameras
# fonts-thai-tlwg / dejavu: Thai + Latin text on the pictures sent with alerts
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-thai-tlwg fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Claude Code CLI — only needed for AI_ENGINE=claude-code (Claude Pro/Max plan instead of an API key).
# Build with --build-arg WITH_CLAUDE_CODE=0 to leave it out.
ARG WITH_CLAUDE_CODE=1
RUN if [ "$WITH_CLAUDE_CODE" = "1" ]; then npm install -g @anthropic-ai/claude-code && npm cache clean --force; fi

COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=8080 \
    DISABLE_AUTOUPDATER=1
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "src/main.js"]
