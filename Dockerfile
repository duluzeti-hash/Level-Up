FROM node:20-slim

WORKDIR /app

# Instala ferramentas de construção para Node-gyp
RUN apt-get update && apt-get install -y build-essential python3

COPY package.json package-lock.json ./
RUN npm install --production

COPY . .
EXPOSE 8080
CMD ["npm", "start"]
