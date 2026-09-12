# Gemini Image Translator

Chrome Extension สำหรับแปลภาษาบนภาพและหน้าเว็บ (รองรับทั้งแท็ก `<img>`, CSS `background-image`, และ HTML5 `<canvas>`) โดยทำงานร่วมกับ **Backend Proxy Server (FastAPI)** เพื่อความปลอดภัยสูงสุด ป้องกันการรั่วไหลของ Gemini API Key จากการตรวจสอบโค้ดส่วนเสริม

---

## สถาปัตยกรรมความปลอดภัย (Security Architecture)

```text
[ Chrome Extension ] ──(User Auth Token)──> [ Backend Proxy Server ] ──(GEMINI_API_KEY)──> [ Gemini API ]
(ไม่มี API Key ใน Client)                      (เก็บ Key ใน .env บน Server)
```

1. **ไม่ฝัง API Key ใน Extension**: ส่วนเสริมจะเก็บเฉพาะ URL ของ Proxy Server และ Auth Token ของผู้ใช้เท่านั้น
2. **Server-Side API Call**: Backend Proxy Server เป็นตัวกลางเพียงผู้เดียวที่มีสิทธิ์เข้าถึง `GEMINI_API_KEY`
3. **User Authentication**: ผู้ใช้ยืนยันตัวตนด้วย User Auth Token หรือเข้าสู่ระบบด้วย Username/Password

---

## 1. วิธีรัน Backend Proxy Server (บน Render.com หรือในเครื่อง)

### ตัวเลือกที่ 1: Deploy บน Render.com (ฟรี 24 ชม. — แนะนำ)
1. ดูคู่มือขั้นตอนอย่างละเอียดได้ที่ [server/DEPLOY_RENDER.md](../server/DEPLOY_RENDER.md)
2. สร้าง Web Service บน [dashboard.render.com](https://dashboard.render.com)
3. กำหนด Root Directory: `server`, Build Command: `pip install -r requirements.txt`, Start Command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. ใส่ Environment Variable: `GEMINI_API_KEY`
5. จะได้ URL เช่น `https://gemini-translator-proxy.onrender.com` นำไปใส่ใน Extension ได้ทันที

### ตัวเลือกที่ 2: รันในเครื่อง (Localhost)
1. เข้าไปยังโฟลเดอร์ `server`:
   ```bash
   cd server
   ```
2. สร้างไฟล์ `.env` จาก `.env.example` แล้วใส่ Gemini API Key ของคุณ:
   ```bash
   cp .env.example .env
   # เปิดไฟล์ .env แล้วใส่ GEMINI_API_KEY=AIzaSy...
   ```
3. เริ่มรันเซิร์ฟเวอร์:
   ```bash
   python run_server.py
   ```
   *(เซิร์ฟเวอร์จะเริ่มทำงานที่ `http://127.0.0.1:8000`)*

---

## 2. วิธีติดตั้ง Extension บน Chrome

1. เปิด `chrome://extensions` ใน Google Chrome
2. เปิดโหมด "Developer mode" (มุมขวาบน)
3. กดปุ่ม "Load unpacked" แล้วเลือกโฟลเดอร์ `gemini-image-translator`
4. คลิกไอคอนส่วนเสริม > **"เปิดหน้าตั้งค่า"**
   - กรอก **Backend Proxy URL** (ค่าเริ่มต้น: `http://127.0.0.1:8000`)
   - กรอก **User Auth Token** (หรือกดขยายส่วน "เข้าสู่ระบบ" แล้วล็อกอินด้วย `admin` / `admin123`)
   - กดปุ่ม **"🔍 ทดสอบการเชื่อมต่อ"** เพื่อตรวจความพร้อม

---

## 3. วิธีใช้งาน
 
 1. **แปลรูปภาพปกติ (`<img>`, `srcset`, `<picture>`)**:
    - คลิกขวาที่รูปภาพใดๆ บนเว็บ > เลือก **"แปลภาพนี้ด้วย Gemini"**
    - รูปภาพจะถูกแทนที่ด้วยเวอร์ชันแปลทับข้อความเดิมอย่างแนบเนียน (รองรับทั้งภาพ responsive `srcset` และแท็ก `<picture>`)
 2. **แปลภาพพื้นหลัง CSS (`background-image`)**:
    - คลิกขวาที่กล่องหรือแบนเนอร์ที่เป็น background-image > เลือก **"แปลภาพพื้นหลังนี้ด้วย Gemini (CSS Background)"**
    - ระบบจะแทนที่ `style.backgroundImage` ด้วยภาพที่แปลแล้วโดยอัตโนมัติ
 3. **เลือกพื้นที่หน้าจอเพื่อแปล (สำหรับ `<canvas>`, มังงะ หรือพื้นที่อิสระ)**:
    - คลิกขวาบนหน้าเว็บ > เลือก **"เลือกพื้นที่หน้าจอเพื่อแปล (Capture Area)"** หรือคลิกที่ไอคอนส่วนเสริมแล้วกด **"📐 ลากกรอบเลือกพื้นที่เพื่อแปล"**
    - ลากเมาส์สร้างกรอบสี่เหลี่ยมรอบบริเวณที่ต้องการแปล (กด `Esc` เพื่อยกเลิก)
    - ผลลัพธ์จะปรากฏเป็น Floating Overlay ทับตำแหน่งเดิม พร้อมปุ่มปิด (✕) และปุ่มกดค้างเพื่อดูภาพต้นฉบับ (👁️ ต้นฉบับ)

---

## ความครอบคลุมโครงสร้างหน้าเว็บ (Cross-Structure Web Support)

| โครงสร้างหน้าเว็บ | กลไกการรองรับและการรับมือ Edge Cases |
|---|---|
| **1. Standard `<img>`** | แทนที่ `img.src` และปรับขนาดให้อัตโนมัติตามสัดส่วนภาพ |
| **2. Responsive `srcset`** | สำรองและถอดแอตทริบิวต์ `srcset` ออก เพื่อป้องกันไม่ให้เบราว์เซอร์บังคับเรนเดอร์ภาพเดิมทับภาพแปล |
| **3. `<picture>` + `<source>`** | อัปเดตทุกลำดับแท็ก `<source srcset="...">` ภายใน `<picture>` เดียวกัน เพื่อให้ภาพแปลแสดงผลในทุกระดับขนาดหน้าจอ (Media Query) |
| **4. Lazy-Loaded Images** | รองรับแอตทริบิวต์ `data-src`, `data-original`, `data-lazy-src` และติดแฟล็ก `data-git-translated="true"` เพื่อป้องกันไม่ให้ Third-party Lazyload Observer (เช่น Lazysizes, Lozad) กวาดภาพเดิมกลับมาทับ |
| **5. CSS `background-image`** | ตรวจจับ CSS `background-image` จากการคลิกขวาผ่าน Content Script พร้อมอัปเดต `style.backgroundImage = url(...)` โดยตรง |
| **6. Strict CSP (`img-src 'self'`)** | หากเว็บไซต์มี Content-Security-Policy เข้มงวดที่ปฏิเสธ `data:` URL ระบบจะตรวจจับและสลับไปใช้ **Canvas Swap** โดยสร้าง `<canvas>` วาดในหน่วยความจำมาวางทับแทน ซึ่งไม่ถูกจำกัดโดยกฎ CSP Network Request |

---

## ฟีเจอร์เด่นที่มีในระบบ

- **CORS & Tainted Canvas Bypass**: ดึงภาพผ่าน Service Worker แปลงเป็น Base64 Data URL ไม่ติด CORS
- **Dominant Background Color Sampling**: สุ่มตัวอย่างสีพื้นหลังรอบขอบข้อความเดิม นำมาปิดทับให้กลืนกับภาพ และปรับสีตัวหนังสือ (ขาว/ดำ) ตาม Contrast อัตโนมัติ
- **Multi-language Word-Wrap & Auto-fit**: ตัดคำภาษาไทย/ญี่ปุ่น/จีน/สากลด้วย `Intl.Segmenter` พร้อมคำนวณขนาดฟอนต์ให้พอดีกับกรอบ
- **Google Fonts Loading & System Fallback**: โหลดฟอนต์ `Noto Sans Thai / JP / SC` อัตโนมัติ พร้อมสลับไปใช้ System Fonts หากโดน CSP บล็อก
- **Storage Cache (LRU)**: บันทึกผลแปลตาม Image Hash ใน `chrome.storage.local` ป้องกันการเรียก API ซ้ำ
- **Exponential Backoff Retry**: ลองใหม่อัตโนมัติเมื่อเจอ 429 Rate Limit หรือเซิร์ฟเวอร์ขัดข้อง

---

## โครงสร้างโปรเจกต์

- `gemini-image-translator/` — โฟลเดอร์ Chrome Extension (Manifest V3)
  - `manifest.json` — Manifest configuration
  - `background.js` — Service worker & shared translation pipeline
  - `content-script.js` — Image replacing, screen area snipping & floating overlay
  - `options.html/js` — หน้าตั้งค่า Proxy URL & Auth Token
  - `popup.html/js` — Popup เมนูลัด
- `server/` — โฟลเดอร์ Backend Proxy Server
  - `main.py` — FastAPI server & Gemini API integration
  - `run_server.py` — สคริปต์เปิดรันเซิร์ฟเวอร์
  - `.env.example` — ไฟล์ตัวอย่าง Environment Variables

