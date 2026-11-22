# Builds the whole app (website + API) into ONE image, for hosting such as Railway.
# Build context is the repository root (the folder that contains both project folders).
#
#   1. build the website (React + Vite)
#   2. build the API (NestJS), copy the website next to it, and start both from one address
#
# The database and photos live on a persistent volume, which is only attached when the container STARTS,
# so migrations and seeding run in railway-start.sh, not here.

# ---- 1. The website ----
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY College-Business-Hub-Frontend/package.json College-Business-Hub-Frontend/package-lock.json ./
RUN npm ci
COPY College-Business-Hub-Frontend/ ./
# Firebase AI Logic settings for Stall mode, baked into the website at build time (all public values).
# On Railway, set them as service variables: Railway passes variables that match an ARG to the build.
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_APP_ID
ARG VITE_RECAPTCHA_ENTERPRISE_SITE_KEY
ARG VITE_GEMINI_CLOUD_MODEL
# No VITE_API_URL: a production build then talks to the address it is served from.
RUN npm run build

# ---- 2. The API, serving the website ----
# The full (non-slim) image includes the compilers better-sqlite3 needs if no ready-made binary exists.
FROM node:22-bookworm
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# The schema and Prisma config must be here before `npm ci`, because the Prisma client is generated from them.
COPY College-Business-Hub-Backend/package.json College-Business-Hub-Backend/package-lock.json ./
COPY College-Business-Hub-Backend/prisma ./prisma
COPY College-Business-Hub-Backend/prisma7.config.ts ./
RUN npm ci
# Prisma 7 does not generate the client on install. Without this, src/generated/prisma does not exist
# (it is gitignored) and `nest build` fails with "Property 'user' does not exist on type 'PrismaService'".
RUN npx prisma generate

COPY College-Business-Hub-Backend/ ./
RUN npm run build
COPY --from=web /web/dist ./public

ENV NODE_ENV=production
CMD ["sh", "/app/railway-start.sh"]
