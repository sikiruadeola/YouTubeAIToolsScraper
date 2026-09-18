FROM apify/actor-node:20
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --omit=dev --omit=optional
COPY . ./
RUN npm run build
CMD npm start
