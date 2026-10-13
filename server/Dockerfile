FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY server/package.json server/package.json
COPY frontend/package.json frontend/package.json
RUN npm install
COPY server server
RUN npm run prisma:generate --workspace=@platform/server && npm run build --workspace=@platform/server
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY server/package.json server/package.json
COPY frontend/package.json frontend/package.json
RUN npm install --workspace=@platform/server
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/prisma server/prisma
COPY --from=build /app/node_modules/.prisma node_modules/.prisma
EXPOSE 4000
CMD ["sh", "-c", "npx prisma migrate deploy --schema server/prisma/schema.prisma && npm run prisma:seed --workspace=@platform/server && node server/dist/index.js"]
