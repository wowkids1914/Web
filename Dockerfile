# --- 依赖安装阶段 (builder) ---
FROM node:22-alpine AS builder

WORKDIR /usr/src/app

# 复制依赖文件并使用 yarn 安装依赖
COPY package.json yarn.lock ./
RUN yarn install --production --frozen-lockfile --verbose

# --- Puppeteer 依赖安装阶段 ---
FROM builder AS puppeteer-deps

# 安装 Puppeteer 和 Chromium 所需系统依赖
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    fontconfig \
    dbus \
    udev \
    alsa-lib \
    bash \
    && rm -rf /var/cache/apk/*

# 设置 Puppeteer 使用系统 Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# --- 最终镜像阶段 ---
FROM puppeteer-deps AS production

WORKDIR /usr/src/app

ENV LANG=zh_CN.UTF-8
ENV LANGUAGE=zh_CN:zh
ENV LC_ALL=zh_CN.UTF-8

# 复制构建产物
COPY dist ./
COPY .env ./
COPY .env.production ./
COPY extensions ./extensions

# 复制 node_modules
COPY --from=builder /usr/src/app/node_modules ./node_modules

CMD ["node", "app.js"]