# One service for Coolify/Hetzner: Node/Express serves the RAMS frontend (static)
# AND its /auth, /admin, /assessments API. Build context = repo root.
# On boot: run DB migrations, seed/reset the admin from env, then start.
FROM node:20-alpine
WORKDIR /app

# Install backend deps (cached unless package files change)
COPY backend/package*.json ./
RUN npm install --omit=dev

# Backend source + the frontend (served from /app/public by express.static)
COPY backend/ ./
COPY frontend/ ./public/

ENV NODE_ENV=production
EXPOSE 3000
CMD ["sh", "-c", "node scripts/migrate.js && node scripts/seed-admin.js && node src/index.js"]
