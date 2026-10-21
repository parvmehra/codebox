FROM node:22-alpine AS build
WORKDIR /app
ARG VITE_API_URL=http://localhost:4000/api
ENV VITE_API_URL=$VITE_API_URL
COPY package*.json ./
COPY frontend/package.json frontend/package.json
COPY server/package.json server/package.json
RUN npm install
COPY frontend frontend
RUN npm run build --workspace=@platform/frontend
FROM nginx:1.27-alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
