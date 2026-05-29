FROM node:20-alpine

WORKDIR /app

# Install dependencies (use lockfile for reproducible builds)
COPY package*.json ./
RUN npm ci

# Build TypeScript -> dist
COPY . .
RUN npm run build

# Railway injects PORT at runtime; the app reads process.env.PORT.
ENV NODE_ENV=production

CMD ["npm", "start"]
