# 使用轻量级的 Node.js 镜像作为基础
FROM node:18-slim

# 设置容器内的内部工作目录
WORKDIR /app

# 先复制依赖文件并安装，利用缓存优化构建速度
COPY package*.json ./
RUN npm install --production

# 复制剩下的所有代码文件
COPY . .

# 开放 3000 端口（你的 server.js 中定义的端口）
EXPOSE 3000

# 启动程序
CMD ["npm", "start"]