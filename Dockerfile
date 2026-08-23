# 构建阶段: 全量依赖 + tsc 编译; 工具链兜底 — better-sqlite3 的 prebuilt 包下载超时(github 不稳)时本地编译
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY plugin ./plugin # syncver (prebuild) 要读写 plugin/.claude-plugin/plugin.json
RUN npm ci && npm run build && npm prune --omit=dev

# 运行阶段: 直接复用构建阶段的 node_modules (已裁掉 dev), 不再跑 npm — 免工具链免二次下载
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data # DB_PATH 默认落这里, node 用户要可写
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
