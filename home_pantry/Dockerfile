ARG BUILD_FROM
FROM $BUILD_FROM

# Install dependencies
RUN \
    apk add --no-cache \
    nodejs \
    npm \
    sqlite \
    curl

# Copy application files
WORKDIR /app
COPY package*.json ./
# --omit=dev replaces the deprecated --production flag. stderr is no longer
# masked, so any native-module build problem is visible in the add-on build log.
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Copy and setup run script
COPY run.sh /
RUN chmod a+x /run.sh

# Health check — ensure the Node process is responsive.
# Uses the lightweight /health route (no DB, no auth) rather than /api/inventory,
# which is both heavy (a full join) and gated by the API auth middleware.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8099/health || exit 1

CMD [ "/run.sh" ]
