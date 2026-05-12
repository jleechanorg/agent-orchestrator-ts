# Integration test environment - simulates fresh developer machine
FROM node:20-bookworm

# Install dependencies that a typical developer would have
RUN apt-get update && apt-get install -y \
    git \
    tmux \
    curl \
    jq \
    python3-yaml \
    && rm -rf /var/lib/apt/lists/*

# Use Corepack so `pnpm` matches the repo packageManager pin (pnpm@9.x in package.json).
# `npm install -g pnpm` often installs pnpm v10+, which breaks `pnpm install -g .`
# layout vs the workspace toolchain and hides the global `ao` shim during onboarding tests.
RUN corepack enable

# Install GitHub CLI (common for developers working with GitHub)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install gh -y \
    && rm -rf /var/lib/apt/lists/*

# Set up working directory
WORKDIR /workspace

# Copy the entire repo (simulates git clone)
COPY . /workspace/agent-orchestrator

# Create a test user (simulates developer's home directory)
RUN useradd -m -s /bin/bash testuser

# Configure npm to use user-local prefix (no sudo needed for npm install -g)
RUN mkdir -p /home/testuser/.npm-global && \
    chown -R testuser:testuser /home/testuser/.npm-global
USER testuser
RUN npm config set prefix '/home/testuser/.npm-global'
ENV PNPM_HOME="/home/testuser/.local/share/pnpm"
ENV PATH="$PNPM_HOME:/home/testuser/.npm-global/bin:$PATH"

WORKDIR /home/testuser

# Entry point will be the test script
CMD ["/bin/bash"]
