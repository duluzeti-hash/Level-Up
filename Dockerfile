ARG FLY_APP_NAME

FROM node:20-alpineFROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
