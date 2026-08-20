FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs core.mjs ./
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
