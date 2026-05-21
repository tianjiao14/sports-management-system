# 使用较新的 Debian 版本，通常对 GLIBC 支持更好
FROM node:18-bookworm

# 安装编译所需的底层工具（必须）
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制配置文件
COPY package*.json ./

# 关键步骤：安装依赖后，强制在该环境下重新编译 sqlite3
# 这会根据当前容器的 glibc 版本生成兼容的二进制文件
RUN npm install --production && \
    npm rebuild sqlite3 --build-from-source

# 复制源代码
COPY . .

EXPOSE 3000
CMD ["npm", "start"]