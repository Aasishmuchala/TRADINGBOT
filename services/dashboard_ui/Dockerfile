FROM node:20-alpine AS build
WORKDIR /app
COPY services/dashboard_ui/package.json .
RUN npm install
COPY services/dashboard_ui/index.html .
COPY services/dashboard_ui/vite.config.js .
COPY services/dashboard_ui/tailwind.config.js .
COPY services/dashboard_ui/postcss.config.js .
COPY services/dashboard_ui/src/ ./src/
COPY services/dashboard_ui/public/ ./public/
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY services/dashboard_ui/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
