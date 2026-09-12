# Privacy Policy — Gemini Image Translator

**Last Updated:** September 12, 2026

This Privacy Policy describes how the **Gemini Image Translator** Chrome Extension ("Extension", "we", "our") collects, uses, and shares information when you use our browser extension.

---

## 1. Information We Collect

### 1.1 Image Data
When you use the Extension to translate text within an image, the **image you select** (or the screen area you capture) is:
1. Downloaded by the Extension's background service worker.
2. Converted to Base64 encoding.
3. Sent to a **Backend Proxy Server** operated by the Extension administrator.
4. The Backend Proxy Server forwards the image data to the **Google Gemini API** (provided by Google LLC) for optical character recognition (OCR) and translation processing.

> **Important:** The image data is transmitted to Google's servers via the Gemini API. Google's use of this data is governed by [Google's Privacy Policy](https://policies.google.com/privacy) and [Google's Generative AI Terms of Service](https://ai.google.dev/gemini-api/terms).

### 1.2 Authentication Token
The Extension stores a **User Authentication Token** in `chrome.storage.local` to authenticate requests to the Backend Proxy Server. This token is:
- Stored locally on your device only.
- Never shared with any third party other than the Backend Proxy Server you configure.

### 1.3 Translation Cache
To improve performance and reduce API calls, the Extension caches translation results locally in `chrome.storage.local` using a SHA-256 hash of the image data as the key. Cached data includes:
- A hash of the original image (not the image itself).
- The translated text segments and their bounding box coordinates.
- No personally identifiable information is stored in the cache.

### 1.4 User Settings
The Extension stores your configuration preferences locally, including:
- Backend Proxy Server URL
- Selected AI model name
- Target translation language
- Authentication credentials (token only, not passwords)

---

## 2. How We Use Information

We use the collected information solely for:
- **Translating text in images** — processing the image through Google Gemini API via the Backend Proxy Server.
- **Caching results** — preventing redundant API calls for identical images.
- **Authenticating requests** — verifying your identity with the Backend Proxy Server.

We do **NOT** use collected information for:
- Advertising, marketing, or user profiling.
- Selling or sharing data with third parties for commercial purposes.
- Training AI models (our Extension does not train models; Google's data usage policies for the Gemini API apply separately).

---

## 3. Data Sharing and Third Parties

| Recipient | Data Shared | Purpose |
|---|---|---|
| **Backend Proxy Server** (configured by user) | Image data (Base64), authentication token | Routes translation requests to the Gemini API securely without exposing the API key |
| **Google Gemini API** (Google LLC) | Image data for OCR and translation | Performs text recognition and translation |
| **Google Fonts** (Google LLC) | Standard HTTP request (no personal data) | Loads multilingual fonts for rendering translated text |

No data is shared with any other third parties.

---

## 4. Data Storage and Security

- **Local Storage Only:** All user settings, authentication tokens, and cached translations are stored exclusively in `chrome.storage.local` on your device.
- **No Remote Database:** The Extension does not maintain any remote user database or analytics system.
- **Secure Transmission:** Communication with the Backend Proxy Server uses HTTPS (when deployed on services like Render.com). Communication between the Backend Proxy Server and Google Gemini API uses Google's secure endpoints.
- **No API Key Exposure:** The Gemini API key is stored only on the Backend Proxy Server (in environment variables), never in the Extension's client-side code or storage.

---

## 5. Data Retention

- **Cached translations** are retained locally until cleared manually by the user or until the LRU cache exceeds 100 entries (oldest entries are automatically removed).
- **Authentication tokens** are retained until the user clears them or changes the configuration.
- **Image data** is not persistently stored — it is processed in-memory and discarded after translation is complete.

---

## 6. Your Rights and Choices

You can:
- **Clear cached translations** at any time through the Extension's Options page.
- **Remove authentication tokens** by clearing the token field in the Options page.
- **Uninstall the Extension** to remove all locally stored data.
- **Choose your Backend Server** — you control which proxy server processes your images.

---

## 7. Permissions Explained

| Permission | Why It's Needed |
|---|---|
| `contextMenus` | Creates right-click menu items ("Translate this image", "Translate background image", "Capture area") |
| `storage` | Stores your settings, authentication token, and translation cache locally |
| `activeTab` | Captures the visible tab for screen area selection and translation |
| `<all_urls>` (host permission) | Allows the background service worker to download images from any website to avoid CORS restrictions |

---

## 8. Children's Privacy

The Extension is not directed at children under 13 years of age. We do not knowingly collect personal information from children.

---

## 9. Changes to This Policy

We may update this Privacy Policy from time to time. Any changes will be reflected by the "Last Updated" date at the top of this document.

---

## 10. Contact

If you have any questions or concerns about this Privacy Policy, please open an issue on the project repository or contact the Extension developer directly.
