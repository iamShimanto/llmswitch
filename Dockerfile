# LLMSwitch — production image
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/dashboard/package.json packages/dashboard/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build --workspaces --if-present

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/packages ./packages
RUN npm ci --omit=dev --no-audit --no-fund
VOLUME ["/app/data"]
EXPOSE 6000
CMD ["node", "packages/cli/bin/llmswitch.js", "serve"]
