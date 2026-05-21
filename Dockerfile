# 使用较完整的 Debian 基础镜像，提供更好的兼容性 
FROM node:18-bookworm

# 安装编译所需的工具链 
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制配置文件
COPY package*.json ./

# 安装依赖并强制在当前环境中从源码重新编译 sqlite3 
RUN npm install --production && \
    npm rebuild sqlite3 --build-from-source

# 复制项目代码
COPY . .

EXPOSE 3000
CMD ["npm", "start"]