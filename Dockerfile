FROM node:24-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY modules ./modules
COPY apps ./apps
RUN pnpm install --frozen-lockfile && pnpm build:editor
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
CMD ["pnpm", "--filter", "@modulo/server", "start"]
