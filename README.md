# Browser Service trên Render (Free plan) + n8n trên VPS riêng

## Kiến trúc

```
VPS (n8n)                              Render (browser-service)
┌─────────────┐                        ┌──────────────────────────┐
│   n8n       │  HTTPS + token   →     │  browser-service          │
│ (workflow)  │  ─────────────────►    │  https://xxx.onrender.com │
└─────────────┘                        └──────────────────────────┘
```

Render tự cấp domain HTTPS công khai cho service — không cần tự cấu hình
firewall/SSL như khi tự thuê VPS. Nhưng đổi lại, Free plan có giới hạn quan
trọng cần biết trước.

## ⚠️ Giới hạn của Render Free plan — đọc trước khi dùng

1. **Service tự "ngủ" (spin down) sau 15 phút không có traffic.** Khi n8n
   gửi request lúc service đang ngủ, Render sẽ "cold start" lại container —
   với Playwright (cần khởi động Chromium), việc này có thể mất **30-90
   giây** cho lần gọi đầu tiên. Nếu n8n có timeout ngắn hơn, request sẽ thất
   bại dù service hoàn toàn bình thường.
   - **Cách xử lý:** đặt `timeoutMs` trong body request đủ lớn (gợi ý ≥
     90000ms cho lần gọi đầu) và đặt timeout của node HTTP Request trong n8n
     tương ứng (Settings → Timeout, đặt ví dụ 120000ms).
   - Có thể tự "giữ ấm" bằng cách thêm 1 node n8n khác gọi `/health` mỗi 10
     phút, nhưng việc này vi phạm tinh thần "free tier" của Render và có thể
     khiến Render giới hạn tài khoản nếu lạm dụng.
2. **750 giờ chạy/tháng** (tính theo dạng cộng dồn các service Free) — nếu
   chỉ chạy 1 service và để nó ngủ khi không dùng, thường không chạm giới
   hạn này với tần suất gọi vài lần/giờ.
3. **RAM giới hạn (512MB trên Free).** Chromium + Playwright khá nặng RAM.
   Nếu service bị crash/OOM (out of memory), cần nâng lên plan Starter trở
   lên ($7/tháng) để có RAM ổn định hơn (thường 512MB Free là mức rất sát,
   dễ bị restart khi render trang nặng).
4. **IP của Render là IP datacenter chia sẻ (shared)**, không phải IP riêng
   cố định — DataDome/WSJ có thể đã có sẵn danh sách chặn các dải IP của các
   nhà cung cấp cloud lớn (AWS, Render dùng AWS bên dưới), nên khả năng bị
   chặn **có thể cao hơn** so với VPS riêng có IP ít bị liệt vào blacklist.

## Bước 1 — Đẩy code lên GitHub

Render build từ Git repo, không upload file trực tiếp như VPS. Tạo 1 repo
(public hoặc private đều được) chứa cấu trúc:

```
your-repo/
├── render.yaml
└── browser-service/
    ├── Dockerfile
    ├── package.json
    └── server.js
```

```bash
cd wsj-render
git init
git add .
git commit -m "Browser service for Render"
git remote add origin <URL_REPO_CUA_BAN>
git push -u origin main
```

## Bước 2 — Deploy bằng Render Blueprint

1. Vào [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint**
2. Chọn repo vừa push
3. Render tự đọc `render.yaml`, hiện preview service `browser-service`
4. Ở bước nhập biến môi trường, điền `BROWSER_SERVICE_TOKEN` (chuỗi bí mật
   dài, tự generate ví dụ bằng `openssl rand -hex 32` trên máy local)
5. Bấm **Apply** → Render build Docker image và deploy

> Build lần đầu có thể mất 3-5 phút vì base image Playwright khá nặng
> (~1.5GB).

Sau khi deploy xong, Render cho 1 URL dạng:
`https://browser-service-xxxx.onrender.com`

## Bước 3 — Test thử bằng curl (từ máy local hoặc VPS)

```bash
curl -X POST https://browser-service-xxxx.onrender.com/fetch-html \
  -H "Content-Type: application/json" \
  -H "x-auth-token: <TOKEN_BAN_DA_DAT>" \
  -d '{"url": "https://www.wsj.com/finance?mod=nav_top_section", "timeoutMs": 90000}'
```

Nếu service đang ngủ, lệnh này sẽ "treo" 30-90s trước khi trả kết quả — đây
là hành vi bình thường của Free plan, không phải lỗi.

## Bước 4 — Cấu hình node n8n (trên VPS riêng)

Thêm node **HTTP Request**:

| Field | Giá trị |
|---|---|
| Method | POST |
| URL | `https://browser-service-xxxx.onrender.com/fetch-html` |
| Headers | `x-auth-token`: *(token đã đặt trên Render)* |
| Headers | `Content-Type`: `application/json` |
| Body (JSON) | `{"url": "https://www.wsj.com/finance?mod=nav_top_section", "timeoutMs": 90000}` |
| Options → Timeout | `120000` (ms) — quan trọng, để chịu được cold start |

## Lên lịch chạy định kỳ

Thêm node **Schedule Trigger**. Vì cold start tốn thời gian, **không nên đặt
interval quá ngắn** (ví dụ mỗi 1-2 phút) — vừa lãng phí, vừa dễ bị Render
giới hạn nếu pattern gọi liên tục bất thường. Gợi ý: mỗi 1-3 giờ.

## Vẫn áp dụng (giống các setup trước)

- **Không đảm bảo vượt được mọi anti-bot** (DataDome) — đặc biệt IP Render
  có thể nằm trong danh sách rủi ro cao của các dịch vụ chống bot.
- **Tôn trọng Terms of Service** của WSJ.
- **Nội dung sau paywall không lấy được** trừ khi có cookie session đăng
  nhập hợp lệ.

## Troubleshooting

- **Request timeout dù service đã "thức"**: kiểm tra log trên Render
  dashboard (tab **Logs**) xem Chromium có lỗi launch không (thường do thiếu
  flag `--no-sandbox` — đã có sẵn trong code, nhưng nếu đổi base image cần
  giữ lại flag này).
- **Lỗi "Out of memory" / service tự restart liên tục**: cân nhắc nâng lên
  Starter plan, hoặc giảm tải bằng cách đóng context ngay sau mỗi request
  (code hiện tại đã làm điều này).
- **Vẫn nhận trang chặn DataDome**: xem phần Troubleshooting trong README
  gốc của setup VPS — vấn đề tương tự, không riêng gì Render.
