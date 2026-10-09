# วิธีการ Deploy Backend Proxy Server ขึ้น Render.com (ฟรี 100%)

คู่มือแนะนำขั้นตอนการนำ Proxy Server ขึ้นสู่ [Render.com](https://render.com) เพื่อให้ Chrome Extension สามารถใช้งานได้จากทุกที่ตลอด 24 ชั่วโมง โดยไม่ต้องเปิดคอมพิวเตอร์ทิ้งไว้

---

## สรุปข้อมูลที่ต้องใช้บน Render

- **Runtime**: `Python 3`
- **Root Directory**: `server`
- **Build Command**: `pip install -r requirements.txt`
- **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- **Environment Variables**:
  - `GEMINI_API_KEY`: *(ใส่ Gemini API Key ที่ได้จาก https://aistudio.google.com)*
  - `AUTH_SECRET_KEY`: `dev-token-secret-68310545` *(หรือกำหนด Secret Token ตามต้องการ)*
  - `DEFAULT_MODEL`: `gemini-2.0-flash`

---

## วิธีที่ 1: Deploy แบบปกติผ่าน Render Web Service (แนะนำ ง่ายที่สุด)

1. **อัปโหลดโปรเจกต์ขึ้น GitHub**:
   - นำโฟลเดอร์นี้ขึ้น GitHub Repository (แบบ Private หรือ Public ก็ได้)

2. **สร้าง Web Service บน Render**:
   - เข้าสู่ระบบที่ [dashboard.render.com](https://dashboard.render.com)
   - คลิกปุ่ม **New +** ที่มุมขวาบน > เลือก **Web Service**
   - เชื่อมต่อและเลือก GitHub Repository ของคุณ

3. **กรอกข้อมูลการตั้งค่า**:
   - **Name**: `gemini-translator-proxy` (หรือชื่อที่ต้องการ)
   - **Region**: `Singapore` (ใกล้ไทย ตอบสนองเร็วที่สุด)
   - **Branch**: `main` (หรือ master)
   - **Root Directory**: `server`
   - **Runtime**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
   - **Instance Type**: `Free`

4. **ตั้งค่า Environment Variables**:
   - เลื่อนลงมาที่หัวข้อ **Environment Variables** แล้วกด **Add Environment Variable**:
     - `GEMINI_API_KEY` = *[Gemini API Key ของคุณ เช่น AIzaSy...]*
     - `AUTH_SECRET_KEY` = `dev-token-secret-68310545` *(หรือ Token อื่นที่คุณต้องการใช้ในส่วนเสริม)*
     - `DEFAULT_MODEL` = `gemini-2.0-flash`

5. **กดปุ่ม Create Web Service**:
   - รอ Render ทำการ Build และ Deploy ประมาณ 1–2 นาที
   - เมื่อขึ้นสถานะ **Live** คุณจะได้ URL ประจำเซิร์ฟเวอร์ เช่น:
     `https://gemini-translator-proxy.onrender.com`

---

## วิธีที่ 2: Deploy ด้วย Render Blueprint (`render.yaml`)

ในโปรเจกต์นี้มีไฟล์ `render.yaml` เตรียมไว้เรียบร้อยแล้ว:
1. ไปที่ [dashboard.render.com](https://dashboard.render.com) > คลิก **New +** > **Blueprint**
2. เลือก Repository ของคุณ
3. Render จะอ่านการตั้งค่าจาก `render.yaml` ให้อัตโนมัติ
4. กรอกค่า `GEMINI_API_KEY` แล้วกด **Apply**

---

## การเชื่อมต่อกับ Chrome Extension

1. คัดลอก URL ของ Render ที่ได้ เช่น:
   `https://gemini-translator-proxy.onrender.com`
2. บน Google Chrome คลิกขวาที่ไอคอนส่วนเสริม > **Options** (หรือเปิดหน้าตั้งค่า)
3. ในช่อง **Backend Proxy URL**: วาง URL ที่ได้ลงไป
4. ในช่อง **User Auth Token**: ใส่ค่าเดียวกับ `AUTH_SECRET_KEY` (หรือเข้าสู่ระบบด้วย `admin` / `admin123`)
5. กดปุ่ม **"🔍 ทดสอบการเชื่อมต่อ"**
   - หากสำเร็จจะขึ้นว่า: `✅ เชื่อมต่อและยืนยันตัวตนสำเร็จ!`
6. กด **"💾 บันทึกการตั้งค่า"** และพร้อมใช้งานได้ทันที!

---

> [!TIP]
> **ข้อสังเกตเกี่ยวกับ Render Free Tier (Cold Start)**:
> บนแพ็กเกจฟรีของ Render หากไม่มีการเรียกใช้งานเกิน 15 นาที เซิร์ฟเวอร์จะเข้าสู่โหมดหลับ (Spin-down) ชั่วคราว เมื่อมีการเรียกใช้งานครั้งแรก อาจใช้เวลาตื่นประมาณ 30–50 วินาที หลังจากนั้นจะตอบสนองรวดเร็วเป็นปกติ
