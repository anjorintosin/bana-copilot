FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api ./apps/api
COPY apps/orchestrator ./apps/orchestrator
COPY apps/workers/package.json ./apps/workers/package.json
COPY packages ./packages
RUN npm install --ignore-scripts --workspace=@meeting-copilot/api --workspace=@meeting-copilot/orchestrator --workspace=@meeting-copilot/types --include-workspace-root
WORKDIR /app/apps/api
ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 8787
CMD ["npx", "tsx", "src/index.ts"]
