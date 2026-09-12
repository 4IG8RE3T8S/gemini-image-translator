# 🌐 Gemini Image Translator

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension%20MV3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/)
[![FastAPI](https://img.shields.io/badge/Backend-FastAPI-009688.svg)](https://fastapi.tiangolo.com/)
[![Render](https://img.shields.io/badge/Deploy-Render-46E3B7.svg)](https://render.com/)
[![Gemini](https://img.shields.io/badge/AI-Google%20Gemini-4285F4.svg)](https://aistudio.google.com/)

**Gemini Image Translator** เป็น Chrome Extension (Manifest V3) สำหรับตรวจจับและแปลภาษาข้อความในรูปภาพบนหน้าเว็บได้ทุกเว็บไซต์แบบเรียลไทม์ ขับเคลื่อนด้วยโมเดล **Google Gemini AI** พร้อมสถาปัตยกรรมความปลอดภัยขั้นสูงผ่าน **Backend Proxy Server** เพื่อป้องกันไม่ให้ API Key รั่วไหลจากการตรวจสอบซอร์สโค้ดในเบราว์เซอร์

---

## 🏗️ สถาปัตยกรรมระบบ (System Architecture)

```text
┌────────────────────────────────┐         ┌────────────────────────────────┐         ┌────────────────────────┐
│  Google Chrome (Client)        │         │  Backend Proxy Server          │         │  Google Cloud          │
│                                │         │  (FastAPI / Render.com)        │         │                        │
│  • Content Script              │         │                                │         │  Gemini 2.5 Flash API  │
│  • Screen Snipping Tool        │ ──Auth──> • HMAC Token Verification      │ ──Key───>                        │
│  • Background Service Worker   │  Bearer │ • Quota & Error Handling       │  HTTPS  │  • OCR Text Detection  │
│  • Canvas Renderer             │  Token  │ • Base64 Sanitization          │         │  • Multilingual Trans  │
│  (ไม่มี Gemini Key ใน Client)   │         │ (เก็บ GEMINI_API_KEY ปลอดภัย)  │         │  • Bounding Boxes      │
└────────────────────────────────┘         └────────────────────────────────┘         └────────────────────────┘
```

### ✨ ฟีเจอร์หลัก (Key Features)

1. **🔒 Security-First Proxy Architecture**:
   - ไม่มี Gemini API Key ฝังใน Extension
   - ยืนยันตัวตนด้วย Stateless HMAC-signed Tokens (เซิร์ฟเวอร์ตื่นจาก Sleep หรือ Restart แล้ว Session ไม่หลุด)
2. **🎨 Smart Background Color Sampling**:
   - ตรวจจับเฉดสีพื้นหลังหลัก (Dominant Color) รอบขอบกล่องข้อความจากภาพต้นฉบับ
   - วาดกล่องสีทับข้อความเดิมได้อย่างแนบเนียน พร้อมคำนวณ Perceived Luminance เพื่อเลือกสีข้อความ (ขาว/ดำ) ให้อ่านง่าย
3. **📐 Adaptive Typography & Word Wrapping**:
   - ตัดคำอัจฉริยะด้วย `Intl.Segmenter` รองรับภาษาไทย ญี่ปุ่น จีน เกาหลี และสากล
   - อัลกอริทึมคำนวณขนาดตัวอักษรที่ใหญ่ที่สุดที่พอดีกรอบ โดยไม่บีบตัวหนังสือจนเล็กเกินไป
   - โหลด Google Fonts (`Noto Sans Thai`, `Noto Sans JP`, `Noto Sans SC`) อัตโนมัติพร้อม System Fallback
4. **✂️ Screen Area Snipping (ลากกรอบเลือกพื้นที่หน้าจอ)**:
   - จับภาพหน้าจอด้วย `chrome.tabs.captureVisibleTab` และครอปด้วย Canvas
   - รองรับทุกเว็บไซต์ รวมถึงเว็บที่ใช้ CSS `background-image`, HTML5 `<canvas>`, หรือ SVG
   - Floating Overlay แสดงผลแปลบนพื้นที่เดิม พร้อมปุ่มกดค้างเพื่อสลับดูภาพต้นฉบับ
5. **⚡ Smart Caching & Exponential Backoff**:
   - ระบบ LRU Cache จัดเก็บผลแปลตาม SHA-256 Hash ของรูปภาพบน `chrome.storage.local` ไม่เรียก API ซ้ำ
   - จัดการ Exponential Backoff + Jitter อัตโนมัติเมื่อพบ HTTP 429 (Rate Limit) หรือ 5xx
6. **🛡️ Cross-Structure & Strict CSP Compatibility**:
   - รองรับภาพแบบ Standard `<img>`, Responsive `<picture>`, `srcset`, และ Lazy-load
   - มีระบบ **Canvas Swap Fallback** บายพาสกฎ Content-Security-Policy (CSP) แบบ `img-src 'self'`

---

## 📁 โครงสร้างโปรเจกต์ (Repository Structure)

```text
gemini-image-translator/
├── gemini-image-translator/      # Chrome Extension (Manifest V3)
│   ├── manifest.json             # การตั้งค่า Extension (Icons, Permissions, Scripts)
│   ├── background.js             # Service Worker (Translation Pipeline, Caching, Retry)
│   ├── content-script.js         # In-page Renderer (DOM Replacement, Snipping, Fonts)
│   ├── popup.html / popup.js     # Popup เมนูสั่งงานด่วน
│   ├── options.html / options.js # หน้าตั้งค่า Server URL และ Auth Login
│   ├── icons/                    # ไอคอน 16px, 32px, 48px, 128px
│   ├── PRIVACY_POLICY.md         # นโยบายความเป็นส่วนตัว (ส่งข้อมูลไป Gemini API)
│   ├── STORE_LISTING.md          # ข้อมูลสำหรับเผยแพร่บน Chrome Web Store
│   └── README.md                 # คู่มือการใช้งาน Extension
│
├── server/                       # Backend Proxy Server (FastAPI)
│   ├── main.py                   # FastAPI Application & Gemini Proxy Endpoints
│   ├── run_server.py             # Script สำหรับรัน Localhost Dev Server
│   ├── requirements.txt          # Python Dependencies
│   ├── .env.example              # ตัวอย่าง Environment Variables
│   └── DEPLOY_RENDER.md          # คู่มือการ Deploy บน Render.com อย่างละเอียด
│
├── test_pages/                   # ชุดหน้าเว็บสำหรับทดสอบ Cross-Structure
│   ├── test_suite.html           # Comprehensive Test Suite สำหรับทุกกรณีโครงสร้าง
│   └── sample_text_card.png      # รูปภาพการ์ดข้อความตัวอย่าง
│
├── render.yaml                   # Render Blueprint Specification (One-Click Deploy)
├── requirements.txt              # Root Dependencies
├── .gitignore                    # Git Ignore rules
└── README.md                     # เอกสารหลักของโปรเจกต์
```

---

## 🚀 เริ่มต้นใช้งาน (Getting Started)

### ขั้นตอนที่ 1: ติดตั้งและรัน Backend Proxy Server

#### ตัวเลือก A: Deploy บน Render.com (แนะนำ — ฟรี 24 ชม.)
1. เชื่อมต่อ Git Repository นี้กับ [dashboard.render.com](https://dashboard.render.com)
2. เลือก **New Blueprint** และเลือกไฟล์ `render.yaml`
3. กำหนดค่า Environment Variable `GEMINI_API_KEY` (รับฟรีที่ [Google AI Studio](https://aistudio.google.com))
4. เมื่อ Deploy เสร็จจะได้ URL เช่น `https://gemini-translator-proxy.onrender.com`
*(ดูรายละเอียดเพิ่มเติมได้ที่ [server/DEPLOY_RENDER.md](server/DEPLOY_RENDER.md))*

#### ตัวเลือก B: รันบนเครื่องตนเอง (Localhost)
```bash
# 1. ติดตั้ง Python dependencies
cd server
pip install -r requirements.txt

# 2. คัดลอกและตั้งค่า .env
cp .env.example .env
# เปิดไฟล์ .env แล้วใส่ GEMINI_API_KEY=AIzaSy...

# 3. รันเซิร์ฟเวอร์
python run_server.py
```
เซิร์ฟเวอร์จะพร้อมทำงานที่ `http://127.0.0.1:8000`

---

### ขั้นตอนที่ 2: ติดตั้ง Extension บน Google Chrome

1. เปิด Google Chrome แล้วไปที่ `chrome://extensions`
2. เปิดสวิตช์ **Developer mode** (มุมขวาบน)
3. กดปุ่ม **Load unpacked** (โหลดส่วนขยายที่คลายการบีบอัดแล้ว)
4. เลือกโฟลเดอร์ `gemini-image-translator/gemini-image-translator`
5. คลิกที่ไอคอนส่วนขยายบนแถบ Toolbar > กด **"⚙️ เปิดหน้าตั้งค่า"**
   - **Backend Proxy URL**: ใส่ URL ของเซิร์ฟเวอร์ Render หรือ `http://127.0.0.1:8000`
   - **User Auth Token**: ใส่ Token หรือเข้าสู่ระบบด้วย Username: `admin` / Password: `admin123`
   - กดปุ่ม **"🔍 ทดสอบการเชื่อมต่อ"** เพื่อยืนยันความพร้อม

---

## 🧪 การทดสอบระบบ (Testing)

สามารถทดสอบการทำงานของ Extension กับโครงสร้างเว็บต่างๆ ได้ที่ชุดทดสอบ [test_pages/test_suite.html](test_pages/test_suite.html):
- **Test 1**: Standard `<img>` Tag
- **Test 2**: Responsive `<picture>` with multiple `<source>`
- **Test 3**: Responsive `srcset` attributes
- **Test 4**: Lazy-loaded images (`data-src`, `data-original`)
- **Test 5**: CSS `background-image` elements
- **Test 6**: Strict Content-Security-Policy (CSP) Canvas Swap
- **Test 7**: Interactive HTML5 `<canvas>` (ผ่าน Screen Snipping)

---

## 📜 License & Privacy

- รายละเอียดนโยบายความเป็นส่วนตัว: [PRIVACY_POLICY.md](gemini-image-translator/PRIVACY_POLICY.md)
- เอกสาร Chrome Web Store Listing: [STORE_LISTING.md](gemini-image-translator/STORE_LISTING.md)
