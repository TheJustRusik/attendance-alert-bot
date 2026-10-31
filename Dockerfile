FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

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
