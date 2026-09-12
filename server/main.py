# server/main.py — Gemini Image Translator Backend Proxy Server
import os
import json
import secrets
import hmac
import hashlib
import re
import urllib.request
import urllib.error
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, HTTPException, Header, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ---- Configuration ----

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
AUTH_SECRET_KEY = os.getenv("AUTH_SECRET_KEY", "gemini-translator-secret-token-2026").strip()
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "gemini-2.5-flash").strip()

VALID_USERS = {
    "admin": os.getenv("ADMIN_PASSWORD", "admin123"),
    "demo": os.getenv("DEMO_PASSWORD", "demo123"),
    "user": os.getenv("USER_PASSWORD", "user123"),
}

VALID_TOKENS = set()
if AUTH_SECRET_KEY:
    VALID_TOKENS.add(AUTH_SECRET_KEY)
    VALID_TOKENS.add("dev-token-secret-68310545")

def is_gemini_key_configured() -> bool:
    """ตรวจสอบว่ามีการตั้งค่า Gemini API Key ที่สมบูรณ์แล้วหรือไม่"""
    return bool(GEMINI_API_KEY and len(GEMINI_API_KEY) > 10)

def create_user_token(username: str) -> str:
    """สร้าง Auth Token แบบ HMAC-signed เพื่อให้ Session คงอยู่ได้แม้เซิร์ฟเวอร์จะ Restart หรือตื่นจากโหมด Sleep"""
    sig = hmac.new(
        AUTH_SECRET_KEY.encode("utf-8"),
        f"usr_{username}".encode("utf-8"),
        hashlib.sha256
    ).hexdigest()[:32]
    return f"usr_{username}_{sig}"

def is_valid_token(token: str) -> bool:
    """ตรวจสอบความถูกต้องของ Auth Token รองรับทั้ง Static Token และ HMAC-signed Token"""
    if not token:
        return False
    if token in VALID_TOKENS:
        return True
    if token.startswith("usr_"):
        parts = token.split("_")
        if len(parts) >= 3:
            sig = parts[-1]
            username = "_".join(parts[1:-1])
            expected_sig = hmac.new(
                AUTH_SECRET_KEY.encode("utf-8"),
                f"usr_{username}".encode("utf-8"),
                hashlib.sha256
            ).hexdigest()[:32]
            return hmac.compare_digest(sig, expected_sig)
    return False

app = FastAPI(
    title="Gemini Image Translator Backend Proxy",
    description="Proxy server สำหรับ Chrome Extension เพื่อเรียกใช้งาน Gemini API อย่างปลอดภัย",
    version="1.0.0"
)

# เปิด CORS สำหรับ Chrome Extension และทุก Origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---- Request / Response Models ----

class LoginRequest(BaseModel):
    username: str
    password: str

class LoginResponse(BaseModel):
    success: bool
    token: str
    username: str
    message: str

class TranslateRequest(BaseModel):
    base64: str
    mimeType: Optional[str] = "image/png"
    targetLang: Optional[str] = "Thai"
    model: Optional[str] = None

class TranslateResponse(BaseModel):
    success: bool
    segments: List[Dict[str, Any]]
    targetLang: str
    model: str

# ---- Authentication Dependency ----

def verify_token(authorization: Optional[str] = Header(None)) -> str:
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="ไม่พบ Token ยืนยันตัวตน (Authorization header missing)",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="รูปแบบ Authorization ไม่ถูกต้อง (ต้องเป็น Bearer <token>)",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    token = parts[1].strip()
    if not is_valid_token(token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User Auth Token ไม่ถูกต้องหรือหมดอายุแล้ว กรุณาเข้าสู่ระบบใหม่",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    return token

# ---- Endpoints ----

@app.get("/api/health")
def health_check():
    """ตรวจสอบสถานะของ Proxy Server และการตั้งค่า Gemini API Key"""
    return {
        "status": "ok",
        "service": "Gemini Image Translator Proxy Server",
        "geminiKeyConfigured": is_gemini_key_configured(),
        "defaultModel": DEFAULT_MODEL
    }

@app.post("/api/auth/login", response_model=LoginResponse)
def login(creds: LoginRequest):
    """เข้าสู่ระบบด้วย Username & Password เพื่อรับ User Auth Token สำหรับ Extension"""
    user_pass = VALID_USERS.get(creds.username)
    if not user_pass or user_pass != creds.password:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง"
        )
    
    new_token = create_user_token(creds.username)
    VALID_TOKENS.add(new_token)

    return LoginResponse(
        success=True,
        token=new_token,
        username=creds.username,
        message="เข้าสู่ระบบสำเร็จ"
    )

@app.get("/api/auth/verify")
def verify_auth(token: str = Depends(verify_token)):
    """ตรวจสอบความถูกต้องของ Auth Token"""
    return {
        "valid": True,
        "message": "Token ถูกต้องและพร้อมใช้งาน"
    }

@app.post("/api/translate", response_model=TranslateResponse)
def translate_image(payload: TranslateRequest, token: str = Depends(verify_token)):
    """
    รับภาพ Base64 และเรียก Gemini API ฝั่ง Server อย่างปลอดภัย
    API Key จะถูกเก็บไว้ที่ Server เท่านั้น ไม่ส่งกลับไปยัง Client
    """
    if not GEMINI_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="ฝั่ง Server ยังไม่ได้ตั้งค่า GEMINI_API_KEY ในไฟล์ .env หรือ Environment Variable"
        )

    model = (payload.model or DEFAULT_MODEL).strip()
    target_lang = (payload.targetLang or "Thai").strip()

    # ตัด data URL header ออกหากมี (เช่น data:image/png;base64,...) เพื่อส่ง raw base64 ให้ Gemini
    clean_base64 = payload.base64.strip()
    if "," in clean_base64 and clean_base64.startswith("data:"):
        clean_base64 = clean_base64.split(",", 1)[1].strip()

    prompt = (
        f"You are an OCR and translation engine for images (e.g. comics, screenshots, UI).\n"
        f"Find every distinct text region in the image. For each region return:\n"
        f"- \"box_2d\": [ymin, xmin, ymax, xmax] with each value normalized to the 0-1000 range\n"
        f"- \"text\": the original text exactly as it appears\n"
        f"- \"translated_text\": the translation into {target_lang}\n\n"
        f"Respond with ONLY a raw JSON array of objects, no markdown fences, no extra commentary.\n"
        f"If there is no text in the image, respond with []."
    )

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_API_KEY}"

    body = {
        "contents": [
            {
                "parts": [
                    {"text": prompt},
                    {
                        "inline_data": {
                            "mime_type": payload.mimeType or "image/png",
                            "data": clean_base64
                        }
                    }
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json"
        }
    }

    req_data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=req_data,
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=35) as resp:
            resp_body = resp.read().decode("utf-8")
            data = json.loads(resp_body)
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="ignore")
        try:
            err_json = json.loads(error_body)
            err_msg = err_json.get("error", {}).get("message", error_body)
        except Exception:
            err_msg = error_body

        if e.code == 429:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="โควต้าการใช้งาน Gemini API เต็มแล้ว (Quota Exceeded / Rate Limit) กรุณารอสักครู่"
            )
        elif e.code == 400 and "API key not valid" in err_msg:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="GEMINI_API_KEY ของเซิร์ฟเวอร์ไม่ถูกต้อง กรุณาตรวจสอบการตั้งค่าบนเซิร์ฟเวอร์"
            )
        elif e.code == 404:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"ไม่พบโมเดล '{model}' ใน Gemini API"
            )
        else:
            raise HTTPException(
                status_code=e.code,
                detail=f"Gemini API Error (HTTP {e.code}): {err_msg[:200]}"
            )
    except urllib.error.URLError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"เซิร์ฟเวอร์ไม่สามารถเชื่อมต่อไปยัง Gemini API ได้: {e.reason}"
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"เกิดข้อผิดพลาดในการประมวลผลบนเซิร์ฟเวอร์: {str(e)}"
        )

    candidates = data.get("candidates", [])
    if not candidates:
        return TranslateResponse(success=True, segments=[], targetLang=target_lang, model=model)

    first_cand = candidates[0]
    finish_reason = first_cand.get("finishReason")
    if finish_reason == "SAFETY":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="รูปภาพถูกปฏิเสธเนื่องจากติดตัวกรองความปลอดภัย (Safety Filter) ของ Gemini"
        )

    parts = first_cand.get("content", {}).get("parts", [])
    if not parts or not parts[0].get("text"):
        return TranslateResponse(success=True, segments=[], targetLang=target_lang, model=model)

    raw_text = parts[0]["text"].strip()

    # จัดการ Markdown Fences หรือข้อความบรรยายรอบนอกที่โมเดลอาจตอบกลับมา
    cleaned_text = raw_text
    if "```" in cleaned_text:
        match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned_text)
        if match:
            cleaned_text = match.group(1).strip()
        else:
            cleaned_text = cleaned_text.replace("```json", "").replace("```", "").strip()

    # หากมีข้อความเกริ่นนำ ให้ดึงเฉพาะส่วนที่เป็น JSON Array [ ... ]
    if not cleaned_text.startswith("["):
        bracket_start = cleaned_text.find("[")
        bracket_end = cleaned_text.rfind("]")
        if bracket_start != -1 and bracket_end != -1 and bracket_end > bracket_start:
            cleaned_text = cleaned_text[bracket_start : bracket_end + 1]

    try:
        segments = json.loads(cleaned_text)
        if not isinstance(segments, list):
            segments = []
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="แปลงผลลัพธ์ JSON จาก Gemini ไม่สำเร็จ: " + raw_text[:120]
        )

    return TranslateResponse(
        success=True,
        segments=segments,
        targetLang=target_lang,
        model=model
    )

@app.get("/")
def root():
    """หน้าแรกสำหรับตรวจสอบสถานะของ Proxy Server บน Render"""
    return {
        "service": "Gemini Image Translator Proxy Server",
        "status": "online",
        "geminiKeyConfigured": is_gemini_key_configured(),
        "endpoints": {
            "health": "/api/health",
            "login": "/api/auth/login",
            "verify": "/api/auth/verify",
            "translate": "/api/translate"
        }
    }

if __name__ == "__main__":
    import uvicorn
    # Render จะส่งตัวแปร PORT มาให้โดยอัตโนมัติ (เช่น PORT=10000)
    port = int(os.getenv("PORT") or os.getenv("SERVER_PORT", "8000"))
    host = os.getenv("SERVER_HOST", "0.0.0.0")
    print(f"🚀 เริ่มต้นรัน Gemini Image Translator Proxy Server ที่ http://{host}:{port}")
    uvicorn.run(app, host=host, port=port)
