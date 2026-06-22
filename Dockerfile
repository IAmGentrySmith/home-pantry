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
RUN npm ci --production 2>/dev/null || npm install --production

COPY . .

# Copy and setup run script
COPY run.sh /
RUN chmod a+x /run.sh

# Health check — ensure the Node process is responsive
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8099/api/inventory || exit 1

CMD [ "/run.sh" ]
