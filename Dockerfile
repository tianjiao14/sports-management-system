# 必须使用基于 Debian 的镜像以保证编译工具链的完整性
FROM node:18-bookworm

# 安装构建工具链，确保有足够的能力在模拟环境下编译 native 模块
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制依赖定义
COPY package*.json ./

# 🌟 关键：安装依赖并强制在该架构下从源码重建所有原生模块
# --build-from-source 会确保 sqlite3 不会去下载预编译包，而是直接编译
RUN npm install --production && \
    npm rebuild sqlite3 --build-from-source

# 复制源代码
COPY . .

EXPOSE 3000
CMD ["npm", "start"]