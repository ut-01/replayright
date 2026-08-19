FROM mcr.microsoft.com/playwright:v1.62.1-jammy

# Install Xvfb (needed by Phase 4.1's display.js for headed browsers on headless systems)
RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies. The base image already ships Chromium, so we skip
# the playwright browser install step and just install Node dependencies.
RUN npm install --ignore-scripts

# Copy the rest of the source
COPY src ./src
COPY sites ./sites

# The mcr.microsoft.com/playwright:jammy image includes a non-root "pwuser".
# Switch to that user to avoid running Chromium as root (which requires --no-sandbox).
USER pwuser

ENTRYPOINT ["node", "src/cli.js"]
