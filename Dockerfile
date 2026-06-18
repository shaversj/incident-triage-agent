FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=development

COPY package.json package-lock.json README.md ./

RUN npm ci

COPY src ./src
COPY fixtures ./fixtures
COPY services ./services
COPY .agents ./.agents
COPY tsconfig.json tsconfig.build.json ./

ENTRYPOINT ["npm", "run", "triage", "--"]
CMD ["list"]
