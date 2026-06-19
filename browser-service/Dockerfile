FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./

# Render tự inject biến PORT khi chạy container — server.js đã đọc
# process.env.PORT nên không cần set cứng giá trị ở đây.
# EXPOSE chỉ mang tính khai báo, không ảnh hưởng routing của Render.
EXPOSE 4000

CMD ["node", "server.js"]
