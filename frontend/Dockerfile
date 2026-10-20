FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Rewrites are resolved at build time, so the API address is needed here too.
ARG API_INTERNAL_URL=http://api:8000/api
ENV API_INTERNAL_URL=$API_INTERNAL_URL
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
