FROM node:16

WORKDIR /usr/src/app

COPY package*.json ./
COPY storeProducts.json ./

RUN npm install

COPY . .

CMD [ "node", "index.js" ]