FROM node:20.20.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY src/ ./src/
USER node
ENTRYPOINT ["node", "/app/src/runner.mjs"]
