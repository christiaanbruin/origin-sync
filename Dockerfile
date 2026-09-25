FROM node:18-slim

# Installeer fpcalc (Chromaprint) op de Linux container
RUN apt-get update && apt-get install -y libchromaprint-tools ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
