FROM node:24-alpine
ENV NODE_ENV=production PORT=10000
WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=8s --start-period=15s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
