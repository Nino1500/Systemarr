FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3010 HOST_ROOT=/host PROC_ROOT=/host/proc SYS_ROOT=/host/sys
COPY --from=build /app/dist ./dist
EXPOSE 3010
USER node
CMD ["node", "dist/index.js"]
