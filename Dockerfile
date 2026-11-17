# Receipt Boss — small, no build step, no native modules.
FROM node:22-bookworm-slim

# rclone is only needed for the optional Google Drive backup
RUN apt-get update \
 && apt-get install -y --no-install-recommends rclone ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
# installs production deps and vendors the OCR engine/model (postinstall)
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
RUN node scripts/vendor-ocr.js && chown -R node:node /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    RCLONE_CONFIG=/config/rclone.conf
# /data: database, photos, local backups.  /config: rclone's Google Drive login.
RUN mkdir -p /data /config && chown node:node /data /config
VOLUME ["/data", "/config"]

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "scripts/healthcheck.js"]
ENTRYPOINT ["tini", "--"]
CMD ["node", "--no-warnings", "server/index.js"]
