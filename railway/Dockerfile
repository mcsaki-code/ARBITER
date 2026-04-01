FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production && \
    npm install typescript tsx @supabase/supabase-js

# Copy worker code
COPY railway/ ./railway/

# Run the worker with tsx (TypeScript execution)
CMD ["npx", "tsx", "railway/worker.ts"]
