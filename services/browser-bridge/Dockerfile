# Browser bridge: real headless Chrome for ChatGPT Web turns.
# Chrome-for-Testing is fetched with curl (the puppeteer installer is
# unreliable on some networks; the direct zip download is not).
FROM node:22-slim

ARG CHROME_VERSION=155.0.8059.84

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl unzip ca-certificates \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2 libpango-1.0-0 libcairo2 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/chrome \
    && curl -sL -o /tmp/chrome.zip \
       "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip" \
    && unzip -q /tmp/chrome.zip -d /opt/chrome \
    && rm /tmp/chrome.zip \
    && chmod +x /opt/chrome/chrome-linux64/chrome /opt/chrome/chrome-linux64/chrome_crashpad_handler

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./

ENV CHROME_PATH=/opt/chrome/chrome-linux64/chrome
ENV PORT=6100
EXPOSE 6100
CMD ["node", "server.mjs"]
