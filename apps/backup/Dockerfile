# Off-Cloudflare nightly mirror job (docs/BACKUP.md).
# Same image runs `run`, `prune`, `check` and `restore`; pick with the container args.
FROM node:20.20.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tar \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY src/ ./src/
RUN mkdir -p /work && chown node:node /work
USER node
ENV OCTOCOVE_BACKUP_WORKDIR=/work
ENTRYPOINT ["node", "/app/src/cli.mjs"]
CMD ["run", "--config", "/config/backup.json"]
