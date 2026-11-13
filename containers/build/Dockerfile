# The build machine of a development run: the toolchains that builders' checks and tests need.
# It holds no secrets. The Durable Object copies each branch in, and runs the repository's setup and checks.
FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git python3 xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Foundry, for Solidity repositories.
RUN curl -fsSL https://foundry.paradigm.xyz | bash \
  && /root/.foundry/bin/foundryup --install stable
ENV PATH=/root/.foundry/bin:$PATH

WORKDIR /
CMD ["sleep", "infinity"]
