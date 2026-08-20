FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs core.mjs auth.mjs db.mjs ./
COPY public ./public
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
