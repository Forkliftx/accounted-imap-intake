FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY index.mjs .
# Kör som icke-root; /data är state + felkö (volume)
RUN mkdir -p /data && chown -R node:node /app /data
USER node
CMD ["node", "index.mjs"]
