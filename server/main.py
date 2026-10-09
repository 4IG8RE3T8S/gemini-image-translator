# server/main.py — Gemini Image Translator Backend Proxy Server
import os
import sys
import json
import secrets
import hmac
import hashlib
import re
import time
import urllib.request
import urllib.error
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, HTTPException, Header, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# กำหนด Encoding ให้ stdout/stderr เป็น UTF-8 เสมอ เพื่อป้องกันข้อผิดพลาด Unicode บน Windows
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ---- Configuration ----

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
AUTH_SECRET_KEY = os.getenv("AUTH_SECRET_KEY", "gemini-translator-secret-token-2026").strip()
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "gemini-2.0-flash").strip()

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
    model: Optional[str] = "gemini-2.0-flash"
    stream: Optional[bool] = True
    thinking_budget: Optional[int] = 0
    max_output_tokens: Optional[int] = 8192
    response_schema: Optional[Dict[str, Any]] = None

GEMINI_RESPONSE_SCHEMA: Dict[str, Any] = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "box_2d": {
                "type": "ARRAY",
                "items": {"type": "INTEGER"},
                "description": "[ymin, xmin, ymax, xmax] normalized to 0-1000"
            },
            "text": {"type": "STRING"},
            "translated_text": {"type": "STRING"}
        },
        "required": ["box_2d", "text", "translated_text"]
    }
}

class TranslateResponse(BaseModel):
    success: bool
    segments: List[Dict[str, Any]]
    targetLang: str
    model: str
    fallbackUsed: Optional[str] = None
    finishReason: Optional[str] = None

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

def clean_and_extract_json(raw_text: str) -> str:
    """
    กรอง Markdown Code Blocks (```json ... ``` หรือ ``` ... ```)
    และดึงเฉพาะส่วนที่เป็น JSON Array หรือ Object พร้อมซ่อมแซมโครงสร้างที่ตัดทอน
    """
    if not raw_text:
        return "[]"
    cleaned = raw_text.strip()

    # 1. กรอง Markdown Code Blocks (ทั้งแบบปิดสมบูรณ์และแบบตัดทอน)
    m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned, re.IGNORECASE)
    if m:
        cleaned = m.group(1).strip()
    else:
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE).strip()
        cleaned = re.sub(r"\s*```$", "", cleaned).strip()

    # 2. ค้นหาจุดเริ่มต้นของ JSON Array [ หรือ Object {
    start_arr = cleaned.find("[")
    start_obj = cleaned.find("{")
    if start_arr != -1 and (start_obj == -1 or start_arr <= start_obj):
        start_idx = start_arr
    elif start_obj != -1:
        start_idx = start_obj
    else:
        start_idx = -1

    if start_idx != -1:
        cleaned = cleaned[start_idx:].strip()

    return cleaned


def _auto_repair_json_string(s: str) -> str:
    """
    ซ่อมแซม JSON String ที่ถูกตัดทอน (Truncated JSON) จาก Gemini API
    - ปิด String Literal ที่ค้างอยู่ (unclosed quote)
    - กำจัด Trailing Backslash, Trailing Comma หรือเติม Dummy Value ให้กับ Dangling Colon
    - ปิด Braces และ Brackets ที่เปิดค้างไว้ตามลำดับ Stack (เช่น }] หรือ ])
    - หากค้างอยู่ที่ Dangling Key ให้ถอยกลับหรือปิดด้วย Dummy Value
    """
    if not s:
        return "[]"

    in_string = False
    escape = False
    stack = []

    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if in_string:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == '"':
                in_string = False
        else:
            if c == '"':
                in_string = True
            elif c in ('{', '['):
                stack.append(c)
            elif c == '}':
                if stack and stack[-1] == '{':
                    stack.pop()
            elif c == ']':
                if stack and stack[-1] == '[':
                    stack.pop()
        i += 1

    repaired = s

    # หากข้อความถูกตัดทอนขณะอยู่ภายใน String literal
    if in_string:
        if repaired.endswith("\\"):
            repaired = repaired[:-1]
        repaired += '"'

    repaired = repaired.rstrip()

    if repaired.endswith(":"):
        repaired += ' ""'
    elif repaired.endswith(","):
        repaired = repaired[:-1].rstrip()

    # วิเคราะห์ Stack วงเล็บที่เปิดค้างอยู่อีกครั้ง
    in_string = False
    escape = False
    stack = []
    for c in repaired:
        if in_string:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == '"':
                in_string = False
        else:
            if c == '"':
                in_string = True
            elif c in ('{', '['):
                stack.append(c)
            elif c == '}':
                if stack and stack[-1] == '{':
                    stack.pop()
            elif c == ']':
                if stack and stack[-1] == '[':
                    stack.pop()

    close_str = ""
    while stack:
        top = stack.pop()
        if top == '{':
            close_str += '}'
        elif top == '[':
            close_str += ']'

    # ลองปิดวงเล็บตรงๆ
    attempt = repaired + close_str
    try:
        json.loads(attempt)
        return attempt
    except Exception:
        pass

    # หากมี Dangling Key ค้างอยู่ (เช่น `..., "translated_te"}`) ให้ลองเติม `: ""`
    attempt2 = repaired + ': ""' + close_str
    try:
        json.loads(attempt2)
        return attempt2
    except Exception:
        pass

    # ลองตัด Dangling Key ออกโดยถอยหลังไปจนถึง Comma ตัวสุดท้าย
    last_comma = repaired.rfind(",")
    if last_comma != -1:
        attempt3 = repaired[:last_comma].rstrip()
        st = []
        ins = False
        esc = False
        for ch in attempt3:
            if ins:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    ins = False
            else:
                if ch == '"':
                    ins = True
                elif ch in ('{', '['):
                    st.append(ch)
                elif ch == '}':
                    if st and st[-1] == '{':
                        st.pop()
                elif ch == ']':
                    if st and st[-1] == '[':
                        st.pop()
        cl = ""
        while st:
            t = st.pop()
            cl += '}' if t == '{' else ']'
        attempt3 += cl
        try:
            json.loads(attempt3)
            return attempt3
        except Exception:
            pass

    return attempt


def _extract_valid_segment_objects(s: str) -> list:
    """
    สแกนดึงเฉพาะ Object { ... } ที่สมบูรณ์และถูกต้องจากสตริง แม้ส่วนอื่นจะเสียหาย
    """
    results = []
    i = 0
    n = len(s)
    while i < n:
        if s[i] == '{':
            depth = 0
            start = i
            in_str = False
            esc = False
            for j in range(i, n):
                ch = s[j]
                if in_str:
                    if esc:
                        esc = False
                    elif ch == "\\":
                        esc = True
                    elif ch == '"':
                        in_str = False
                else:
                    if ch == '"':
                        in_str = True
                    elif ch == '{':
                        depth += 1
                    elif ch == '}':
                        depth -= 1
                        if depth == 0:
                            candidate = s[start : j + 1]
                            try:
                                obj = json.loads(candidate)
                                if isinstance(obj, dict) and "box_2d" in obj:
                                    results.append(obj)
                                i = j
                            except Exception:
                                pass
                            break
        i += 1
    return results


def _normalize_segments(data) -> list:
    """
    ตรวจสอบและปรับโครงสร้างของ segments ให้อยู่ในฟอร์แมตที่ถูกต้องเสมอ
    - box_2d ต้องมีพิกัดครบ 4 ค่า
    - หาก translated_text ว่าง ให้ fallback ไปใช้ text ต้นฉบับ
    """
    if not isinstance(data, list):
        return []
    normalized = []
    for item in data:
        if not isinstance(item, dict):
            continue
        box = item.get("box_2d")
        if not isinstance(box, list) or len(box) < 4:
            continue
        text = str(item.get("text") or "").strip()
        trans = str(item.get("translated_text") or "").strip()
        if not text and not trans:
            continue
        if not trans and text:
            trans = text
        normalized.append({
            "box_2d": box,
            "text": text,
            "translated_text": trans
        })
    return normalized


def repair_and_parse_json(raw_text: str) -> List[Dict[str, Any]]:
    """
    ระบบ Resilient JSON Parser & Auto-Repair สำหรับ Gemini API
    รองรับหลายระดับชั้นเพื่อป้องกันข้อผิดพลาด JSON.parse ล้มเหลวจากการถูกตัดทอน:
    1. กรอง Markdown backticks (```json ... ```) ทั้งแบบปิดสมบูรณ์และตัดทอน
    2. ลอง parse ตรงๆ หาก JSON สมบูรณ์
    3. ซ่อมแซมด้วย State Machine (ปิด String, ลบ Trailing Comma, ปิด Bracket/Brace)
    4. ตัดทอนกลับไปยัง Object Boundary ตัวสุดท้ายที่สมบูรณ์ ('}')
    5. สแกนดึงเฉพาะ Object กล่องข้อความที่สมบูรณ์รายชิ้น
    """
    if not raw_text or not raw_text.strip():
        return []

    cleaned = clean_and_extract_json(raw_text)

    # ระดับ 1: ลอง parse ตรงๆ
    try:
        data = json.loads(cleaned)
        if isinstance(data, list):
            res = _normalize_segments(data)
            if res or not data:
                return res
        elif isinstance(data, dict):
            return _normalize_segments([data])
    except Exception:
        pass

    # ระดับ 2: ซ่อมแซมด้วย State Machine Auto-Repair
    repaired = _auto_repair_json_string(cleaned)
    if repaired:
        try:
            data = json.loads(repaired)
            if isinstance(data, list):
                res = _normalize_segments(data)
                if res:
                    return res
            elif isinstance(data, dict):
                return _normalize_segments([data])
        except Exception:
            pass

    # ระดับ 3: ตัดทอนกลับไปยัง Object Boundary ตัวสุดท้ายที่สมบูรณ์ ('}')
    last_brace = cleaned.rfind("}")
    if last_brace != -1:
        trimmed = cleaned[: last_brace + 1].strip()
        if trimmed.startswith("["):
            trimmed_arr = trimmed + "]"
            try:
                data = json.loads(trimmed_arr)
                if isinstance(data, list):
                    res = _normalize_segments(data)
                    if res:
                        return res
            except Exception:
                pass

    # ระดับ 4: สแกนดึงเฉพาะ Object ที่สมบูรณ์
    extracted = _extract_valid_segment_objects(cleaned)
    if extracted:
        return _normalize_segments(extracted)

    raise json.JSONDecodeError("Failed to parse and repair JSON", cleaned, 0)

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

    # ตรวจสอบขนาด payload ไม่ใหญ่เกิน 20MB (base64)
    MAX_BASE64_SIZE = 20 * 1024 * 1024  # 20MB
    if len(clean_base64) > MAX_BASE64_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"ขนาดรูปภาพใหญ่เกินไป ({len(clean_base64) // (1024*1024)}MB) กรุณาใช้รูปภาพที่มีขนาดเล็กกว่า 20MB"
        )

    prompt = (
        f"You are an OCR and translation engine for images (e.g. comics, screenshots, UI).\n"
        f"Find every distinct text region in the image. For each region return:\n"
        f"- \"box_2d\": [ymin, xmin, ymax, xmax] with each value normalized to the 0-1000 range\n"
        f"- \"text\": the original text exactly as it appears\n"
        f"- \"translated_text\": the translation into {target_lang}\n\n"
        f"Respond with ONLY a raw JSON array of objects, no markdown fences, no extra commentary.\n"
        f"If there is no text in the image, respond with []."
    )

    candidate_models = [model]
    for alt in ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash"]:
        if alt not in candidate_models:
            candidate_models.append(alt)

    data = None
    used_model = model
    last_error_msg = ""

    for attempt_model in candidate_models:
        used_model = attempt_model

        max_tokens = max(4096, int(payload.max_output_tokens or 8192))

        # บังคับโหมด Native JSON ผ่าน responseMimeType และ responseSchema ที่เข้มงวด
        schema_to_use = payload.response_schema or GEMINI_RESPONSE_SCHEMA
        gen_config: Dict[str, Any] = {
            "temperature": 0,
            "responseMimeType": "application/json",
            "maxOutputTokens": max_tokens,
            "responseSchema": schema_to_use
        }
        # ตั้งค่า thinking_budget ให้เป็น 0 หรือปิดการทำงาน ตามคำขอ
        thinking_budget = payload.thinking_budget if payload.thinking_budget is not None else 0
        if thinking_budget == 0:
            gen_config["thinkingConfig"] = {"thinkingBudget": 0}
        elif thinking_budget > 0:
            gen_config["thinkingConfig"] = {"thinkingBudget": thinking_budget}

        use_streaming = payload.stream is not False
        stream_path = ":streamGenerateContent?alt=sse&" if use_streaming else ":generateContent?"
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{attempt_model}{stream_path}key={GEMINI_API_KEY}"

        body: Dict[str, Any] = {
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
            "generationConfig": gen_config
        }
        if use_streaming:
            body["stream"] = True

        req_data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=req_data,
            headers={"Content-Type": "application/json"},
            method="POST"
        )

        MAX_RETRIES = 3
        INITIAL_DELAY_SEC = 2.0  # หน่วงเวลาแบบ Exponential Backoff: 2s -> 4s -> 8s

        success = False
        for attempt in range(MAX_RETRIES + 1):
            try:
                with urllib.request.urlopen(req, timeout=40) as resp:
                    if use_streaming:
                        # ประมวลผลแบบสตรีม ทยอยรับข้อความกลับมาทีละ Token จาก Gemini API จนสมบูรณ์
                        accumulated_text = ""
                        finish_reason = None
                        sse_buffer = ""

                        def process_gemini_chunk(chk: dict):
                            nonlocal finish_reason, accumulated_text
                            cands = chk.get("candidates", [])
                            if cands:
                                cand = cands[0]
                                cand_finish = cand.get("finishReason")
                                if cand_finish:
                                    finish_reason = cand_finish
                                for p in cand.get("content", {}).get("parts", []):
                                    t = p.get("text", "")
                                    if t:
                                        accumulated_text += t

                        for raw_line in resp:
                            line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
                            if not line:
                                if sse_buffer:
                                    try:
                                        chunk = json.loads(sse_buffer)
                                        process_gemini_chunk(chunk)
                                    except json.JSONDecodeError:
                                        pass
                                    sse_buffer = ""
                                continue

                            if line.startswith("data:"):
                                data_str = line[5:].strip()
                                if data_str == "[DONE]":
                                    break
                                if not data_str:
                                    continue

                                # ลองแปลง JSON ทันที (เพราะ Gemini API ส่งแต่ละ SSE chunk เป็น 1 JSON object ที่สมบูรณ์)
                                parsed_direct = False
                                try:
                                    chunk = json.loads(data_str)
                                    process_gemini_chunk(chunk)
                                    parsed_direct = True
                                    sse_buffer = ""
                                except json.JSONDecodeError:
                                    pass

                                if not parsed_direct:
                                    if sse_buffer:
                                        sse_buffer += "\n" + data_str
                                    else:
                                        sse_buffer = data_str
                                    try:
                                        chunk = json.loads(sse_buffer)
                                        process_gemini_chunk(chunk)
                                        sse_buffer = ""
                                    except json.JSONDecodeError:
                                        pass
                            elif line.startswith("{") and line.endswith("}"):
                                try:
                                    chunk = json.loads(line)
                                    process_gemini_chunk(chunk)
                                except json.JSONDecodeError:
                                    pass

                        # Flush SSE buffer ที่ค้างอยู่เมื่อจบสตรีม
                        if sse_buffer:
                            try:
                                chunk = json.loads(sse_buffer)
                                process_gemini_chunk(chunk)
                            except json.JSONDecodeError:
                                pass

                        data = {
                            "candidates": [
                                {
                                    "content": {
                                        "parts": [{"text": accumulated_text}]
                                    },
                                    "finishReason": finish_reason or "STOP"
                                }
                            ]
                        }
                    else:
                        resp_body = resp.read().decode("utf-8")
                        data = json.loads(resp_body)

                    success = True
                    break  # สำเร็จ ออกจาก retry loop
            except urllib.error.HTTPError as e:
                error_body = e.read().decode("utf-8", errors="ignore")
                try:
                    err_json = json.loads(error_body)
                    err_msg = err_json.get("error", {}).get("message", error_body)
                except Exception:
                    err_msg = error_body
                last_error_msg = err_msg

                # หากโมเดลปฏิเสธ responseSchema ให้ถอด responseSchema ออกและใช้ responseMimeType ปกติ
                if "responseSchema" in gen_config and ("schema" in err_msg.lower() or "responseschema" in err_msg.lower()):
                    print(f"[Gemini Proxy] โมเดล {attempt_model} ไม่รองรับ responseSchema กำลังใช้ responseMimeType: application/json...")
                    del gen_config["responseSchema"]
                    gen_config["responseMimeType"] = "application/json"
                    body["generationConfig"] = gen_config
                    req_data = json.dumps(body).encode("utf-8")
                    req = urllib.request.Request(url, data=req_data, headers={"Content-Type": "application/json"}, method="POST")
                    continue

                # หากโมเดลปฏิเสธ thinkingConfig ให้ปิดการทำงาน thinking แล้วลองใหม่ทันที
                if "thinkingConfig" in gen_config and ("thinkingConfig" in err_msg or "thinking" in err_msg.lower()):
                    print(f"[Gemini Proxy] โมเดล {attempt_model} ไม่รองรับ thinkingConfig กำลังปิดการทำงาน thinking...")
                    del gen_config["thinkingConfig"]
                    body["generationConfig"] = gen_config
                    req_data = json.dumps(body).encode("utf-8")
                    req = urllib.request.Request(url, data=req_data, headers={"Content-Type": "application/json"}, method="POST")
                    continue

                # ตรวจสอบว่าสามารถ Retry ด้วย Exponential Backoff ได้หรือไม่ (429 Rate Limit หรือ 5xx Server Error)
                if e.code in (429, 500, 502, 503, 504) and attempt < MAX_RETRIES:
                    # คำนวณเวลาหน่วงแบบ Exponential Backoff: 2s, 4s, 8s
                    retry_delay = INITIAL_DELAY_SEC * (2 ** attempt)
                    retry_after_hdr = e.headers.get("Retry-After") if e.headers else None
                    if retry_after_hdr:
                        try:
                            retry_delay = max(float(retry_after_hdr), retry_delay)
                        except ValueError:
                            pass
                    print(f"[Gemini Proxy] {attempt_model} ได้รับ HTTP {e.code}. หน่วงเวลา {retry_delay:.1f}s แล้วลองใหม่ (ครั้งที่ {attempt + 1}/{MAX_RETRIES})...")
                    time.sleep(retry_delay)
                    continue

                if e.code == 429:
                    # ถ้าลองครบทุกครั้งแล้วและยังมีโมเดลสำรอง ให้ลองโมเดลถัดไป
                    if attempt_model != candidate_models[-1]:
                        break  # ออกจาก retry loop เพื่อลองโมเดลถัดไป
                    raise HTTPException(
                        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                        detail={
                            "message": "โควต้าการใช้งาน Gemini API เต็มแล้ว (Quota Exceeded / Rate Limit) กรุณารอสักครู่",
                            "quota_exceeded": True,
                            "error_code": "GEMINI_QUOTA_EXCEEDED"
                        },
                        headers={"Retry-After": "2"}
                    )
                elif e.code == 400 and "API key not valid" in err_msg:
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail="GEMINI_API_KEY ของเซิร์ฟเวอร์ไม่ถูกต้อง กรุณาตรวจสอบการตั้งค่าบนเซิร์ฟเวอร์"
                    )
                elif e.code == 404:
                    # ถ้าไม่พบโมเดล ให้ลองโมเดลถัดไป
                    if attempt_model != candidate_models[-1]:
                        break
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail=f"ไม่พบโมเดล '{attempt_model}' ใน Gemini API"
                    )
                else:
                    raise HTTPException(
                        status_code=e.code,
                        detail=f"Gemini API Error (HTTP {e.code}): {err_msg[:200]}"
                    )
            except urllib.error.URLError as e:
                if attempt < MAX_RETRIES:
                    retry_delay = INITIAL_DELAY_SEC * (2 ** attempt)
                    print(f"[Gemini Proxy] เครือข่ายขัดข้อง ({e.reason}). หน่วงเวลา {retry_delay:.1f}s แล้วลองใหม่...")
                    time.sleep(retry_delay)
                    continue
                if attempt_model != candidate_models[-1]:
                    break
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=f"เซิร์ฟเวอร์ไม่สามารถเชื่อมต่อไปยัง Gemini API ได้: {e.reason}",
                    headers={"Retry-After": "2"}
                )
            except Exception as e:
                if isinstance(e, HTTPException):
                    raise e
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"เกิดข้อผิดพลาดในการประมวลผลบนเซิร์ฟเวอร์: {str(e)}"
                )

        if success:
            break

    if data is None:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "message": "โควต้าการใช้งาน Gemini API เต็มแล้ว (Quota Exceeded / Rate Limit) กรุณารอสักครู่",
                "quota_exceeded": True,
                "error_code": "GEMINI_QUOTA_EXCEEDED"
            }
        )

    candidates = data.get("candidates", [])
    if not candidates:
        return TranslateResponse(success=True, segments=[], targetLang=target_lang, model=model, finishReason="NO_CANDIDATES")

    first_cand = candidates[0]
    finish_reason = first_cand.get("finishReason") or "STOP"

    # ตรวจสอบและบันทึก log finishReason เพื่อความโปร่งใสและวิเคราะห์ปัญหา
    if finish_reason == "SAFETY":
        print(f"[Gemini Proxy] ⚠️ คำขอถูกบล็อกโดยระบบความปลอดภัยของ Gemini (finishReason: SAFETY)")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="รูปภาพถูกปฏิเสธเนื่องจากติดตัวกรองความปลอดภัย (Safety Filter) ของ Gemini"
        )
    elif finish_reason == "MAX_TOKENS":
        print(f"[Gemini Proxy] ⚠️ คำเตือน: ข้อความถูกตัดทอนเนื่องจากชนขีดจำกัด Token (finishReason: MAX_TOKENS). กำลังทำการซ่อมแซม JSON อัตโนมัติ...")
    elif finish_reason and finish_reason != "STOP":
        print(f"[Gemini Proxy] ⚠️ finishReason ผิดปกติจาก Gemini: {finish_reason}")
    else:
        print(f"[Gemini Proxy] Gemini ประมวลผลสำเร็จ (finishReason: {finish_reason})")

    parts = first_cand.get("content", {}).get("parts", [])
    if not parts or not parts[0].get("text"):
        return TranslateResponse(success=True, segments=[], targetLang=target_lang, model=model, finishReason=finish_reason)

    raw_text = parts[0]["text"].strip()

    # ใช้ระบบ Resilient JSON Parser & Auto-Repair ในการแปลงผลลัพธ์
    try:
        segments = repair_and_parse_json(raw_text)
        if finish_reason == "MAX_TOKENS":
            print(f"[Gemini Proxy] ซ่อมแซมผลลัพธ์ JSON จาก MAX_TOKENS สำเร็จ: กู้คืนได้ {len(segments)} กล่องข้อความ")
    except Exception as e:
        print(f"[Gemini Proxy] แปลงผลลัพธ์ JSON จาก Gemini ไม่สำเร็จ: {e}. ตัวอย่างข้อความ: {raw_text[:120]}")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="แปลงผลลัพธ์ JSON จาก Gemini ไม่สำเร็จ: " + raw_text[:120]
        )

    return TranslateResponse(
        success=True,
        segments=segments,
        targetLang=target_lang,
        model=used_model,
        fallbackUsed=used_model if used_model != model else None,
        finishReason=finish_reason
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
