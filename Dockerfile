FROM node:20.19.0-slim

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production

EXPOSE 5173

CMD ["npm", "start"]
