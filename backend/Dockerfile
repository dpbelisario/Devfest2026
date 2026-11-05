FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
RUN npm ci
COPY backend/ backend/
COPY android/app/src/main/assets/contour.html android/app/src/main/assets/contour.html
RUN npm run build --workspace backend

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/backend/dist/src/ backend/dist/src/
COPY backend/data/ backend/dist/data/
COPY --from=build /app/backend/dist/web/ backend/dist/web/
USER node
EXPOSE 8080
CMD ["node", "backend/dist/src/server.js"]
