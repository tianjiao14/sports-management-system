# 1. 使用较完整的镜像版本，包含必要的编译工具依赖
FROM node:18-bookworm

# 2. 安装编译 SQLite3 所需的构建工具
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 3. 复制依赖文件
COPY package*.json ./

# 4. 强制在容器内部根据当前系统环境重新编译依赖
RUN npm install --production && \
    npm rebuild sqlite3 --build-from-source

# 5. 复制源代码
COPY . .

EXPOSE 3000 [cite: 2]
CMD ["npm", "start"]