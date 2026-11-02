FROM node:20-alpine

# Install Chromium and fonts for Playwright headless video playback
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont

WORKDIR /app

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy dependency specifications
COPY package.json package-lock.json* ./

# Install only production dependencies
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# Copy application source code
COPY src ./src

# Switch to non-root user provided by the Node image
USER node

CMD ["node", "src/index.js"]
