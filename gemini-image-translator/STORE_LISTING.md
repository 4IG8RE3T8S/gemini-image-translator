# Chrome Web Store Listing — Gemini Image Translator

## Extension Name
Gemini Image Translator

## Short Description (132 characters max)
แปลข้อความในรูปภาพบนเว็บไซต์ด้วย AI — รองรับทุกภาษา | Translate text in images using Google Gemini AI

## Detailed Description

### 🌐 Gemini Image Translator — แปลภาษาบนรูปภาพอย่างแนบเนียน

**แปลข้อความในรูปภาพบนหน้าเว็บไซต์โดยอัตโนมัติด้วย Google Gemini AI** — ใช้งานง่ายเพียงคลิกขวาที่รูป ส่วนเสริมจะ OCR ตรวจจับข้อความต้นฉบับ แปลเป็นภาษาที่ต้องการ แล้ววาดทับข้อความเดิมให้กลมกลืนกับภาพต้นฉบับอย่างสมบูรณ์แบบ

---

#### ✨ ฟีเจอร์หลัก

🖼️ **แปลข้อความในรูปภาพ**
คลิกขวาที่รูปภาพใดก็ได้บนเว็บ เลือก "แปลภาพนี้ด้วย Gemini" — ข้อความในรูปจะถูกแปลและวาดทับอย่างแนบเนียน โดยรองรับทั้งแท็ก <img>, responsive srcset, <picture> และ lazy-loaded images

🎨 **CSS Background Image Support**
แปลรูปภาพที่เป็น CSS background-image ได้โดยตรงผ่านเมนูคลิกขวา "แปลภาพพื้นหลังนี้"

📐 **เลือกพื้นที่หน้าจอเพื่อแปล (Screen Capture)**
ลากกรอบเลือกพื้นที่อิสระบนหน้าจอ ใช้ได้กับทุกอย่าง — มังงะ, canvas, PDF viewer หรือพื้นที่ใดก็ได้ ผลลัพธ์แสดงเป็น Floating Overlay พร้อมปุ่มกดค้างดูต้นฉบับ

🎯 **Dominant Background Color Sampling**
สุ่มตัวอย่างสีพื้นหลังรอบข้อความในภาพ ปิดทับด้วยสีที่กลมกลืน พร้อมปรับสีตัวอักษร (ขาว/ดำ) ตาม Contrast อัตโนมัติ

✂️ **Multi-language Word-Wrap & Auto-fit**
ตัดคำภาษาไทย ญี่ปุ่น จีน เกาหลี และภาษาสากลอย่างถูกต้องด้วย Intl.Segmenter พร้อมคำนวณขนาดฟอนต์ให้พอดีกรอบ จัดกึ่งกลางทั้งแนวตั้งและแนวนอน

🔤 **Multilingual Fonts**
โหลด Noto Sans Thai / JP / SC / KR อัตโนมัติ พร้อม System Font Fallback หากเว็บไซต์บล็อก External Fonts ด้วย CSP

💾 **Smart Caching**
บันทึกผลแปลไว้ในเครื่องตาม Image Hash — ไม่เรียก API ซ้ำสำหรับภาพเดิม ประหยัดโควตาและเร็วขึ้น

🔄 **Auto-Retry with Exponential Backoff**
ลองแปลใหม่อัตโนมัติเมื่อเจอ Rate Limit (429) หรือ Server Error (5xx) พร้อมข้อความผิดพลาดที่เข้าใจง่าย

🛡️ **ไม่ฝัง API Key ใน Extension**
Gemini API Key อยู่บน Backend Proxy Server เท่านั้น — ไม่รั่วไหลจากการ Inspect Extension โค้ด

🔒 **CSP-Resilient**
รองรับเว็บไซต์ที่มี Content-Security-Policy เข้มงวด ด้วยระบบ Canvas Swap อัตโนมัติ

---

#### 🌏 ภาษาที่รองรับ
ภาษาไทย, ญี่ปุ่น, จีน (ตัวย่อ/ตัวเต็ม), เกาหลี, อังกฤษ, และภาษาอื่นๆ ทั้งหมดที่ Google Gemini รองรับ

---

#### 🔧 ข้อกำหนดในการใช้งาน
• ต้องมี Backend Proxy Server (FastAPI) — สามารถ Deploy ฟรีบน Render.com
• ต้องมี Google Gemini API Key (ตั้งค่าบน Server เท่านั้น ไม่ต้องใส่ใน Extension)
• ดูคู่มือการตั้งค่าฉบับเต็มได้ใน README

---

#### 🔐 ความเป็นส่วนตัว
• รูปภาพที่แปลจะถูกส่งไปยัง Google Gemini API ผ่าน Backend Proxy Server ของคุณ
• ไม่มีการเก็บข้อมูลส่วนบุคคลหรือส่งข้อมูลไปยังบุคคลที่สามอื่น
• อ่านนโยบายความเป็นส่วนตัวฉบับเต็มได้ที่ลิงก์ Privacy Policy

---

## Category
Productivity

## Language
Thai (ไทย), English

## Tags / Keywords
- image translator
- OCR
- Gemini AI
- manga translator
- picture translator
- text in image
- แปลภาพ
- แปลมังงะ
- screenshot translator

## Icon Sizes Required
- 128x128 — icons/icon128.png ✅
- 48x48 — icons/icon48.png ✅
- 16x16 — icons/icon16.png ✅

## Promotional Images
- Small promo tile (440x280) — icons/promo_small_440x280.png ✅
- Large promo tile (920x680) — icons/promo_large_920x680.png ✅
- Marquee promo (1400x560) — icons/promo_marquee_1400x560.png ✅

## Privacy Policy URL
(Provide URL to hosted PRIVACY_POLICY.md — e.g., GitHub Pages or raw GitHub link)
