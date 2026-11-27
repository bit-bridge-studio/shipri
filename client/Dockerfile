# Stage 1: Build
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_SIGNALING_URL=https://poc.shipri.app
ENV VITE_SIGNALING_URL=$VITE_SIGNALING_URL
RUN npm run build

# Stage 2: Serve
FROM nginx:1.25-alpine
ENV SHIPRI_ENV_HEADER=poc-staging
ENV SHIPRI_ROBOTS_HEADER="noindex, nofollow"
ENV NGINX_ENVSUBST_FILTER=^SHIPRI_
COPY --from=build /app/dist /usr/share/nginx/html
# Custom nginx template to route /health, /ready, /socket.io/, and SPA assets
COPY nginx.conf /etc/nginx/templates/default.conf.template
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]