# Multi-platform lightweight Node.js base (ARM64 for Raspberry Pi, x86_64 for standard PCs)
FROM node:20-alpine

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Set working directory
WORKDIR /app

# Install dependencies first (leverages Docker cache layers)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy application source code
COPY src ./src

# Create non-root user for security and stability
USER node

# Expose OCPP & Dashboard port
EXPOSE 3000

# Built-in lightweight healthcheck (uses Node 20 native fetch, zero dependencies)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/status').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Run the OCPP 1.6-J & Firebase Gateway server
CMD ["node", "src/index.js"]
