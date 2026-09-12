FROM node:20-alpine AS base
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev 2>/dev/null || npm install --omit=dev
COPY dist ./dist
CMD ["node", "--version"]
