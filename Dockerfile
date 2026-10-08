FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV SCARF_ANALYTICS=false
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY apps/miniprogram/package.json apps/miniprogram/package.json
RUN npm ci
COPY . .
RUN npm run db:generate && npm run build

FROM build AS api
RUN npm prune --omit=dev
WORKDIR /app/apps/api
ENV HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM nginx:1.28-alpine AS admin
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
