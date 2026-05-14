import os
import re
import base64
import io
import logging

import cv2
import numpy as np
import pytesseract
from flask import Flask, request, jsonify, render_template

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

def preprocess_image(image_bytes: bytes) -> np.ndarray:
    """
    Pre-process a cracked, glowing blue LCD screen image for OCR.
    Steps:
      1. Decode JPEG/PNG bytes → BGR array
      2. Resize to 500 px wide (preserve aspect ratio)
      3. Extract Red channel only  (kills blue/green LCD bloom)
      4. Otsu threshold → clean binary image
    """
    np_arr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")

    # 1. Resize to 500 px wide
    h, w = img.shape[:2]
    target_w = 500
    scale = target_w / w
    new_h = int(h * scale)
    img = cv2.resize(img, (target_w, new_h), interpolation=cv2.INTER_AREA)

    # 2. Red channel only
    red_channel = img[:, :, 2]   # BGR → index 2 = Red

    # 3. Otsu thresholding
    _, binary = cv2.threshold(
        red_channel, 0, 255,
        cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )

    return binary


def run_ocr(binary_image: np.ndarray) -> str:
    """
    Run Tesseract with a digit-only whitelist in single-line mode (PSM 7).
    Returns the cleaned digit string or empty string.
    """
    config = "--psm 7 -c tessedit_char_whitelist=0123456789"
    raw = pytesseract.image_to_string(binary_image, config=config)
    cleaned = re.sub(r"\D", "", raw).strip()
    return cleaned


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/scan", methods=["POST"])
def scan():
    """
    Accepts a JSON body:  { "image": "<base64-encoded JPEG>" }
    Returns:              { "floor": "12" }  or  { "floor": "" }
    """
    try:
        data = request.get_json(force=True, silent=True) or {}
        b64 = data.get("image", "")

        if not b64:
            return jsonify({"error": "No image provided", "floor": ""}), 400

        # Strip data-URL prefix if present
        if "," in b64:
            b64 = b64.split(",", 1)[1]

        image_bytes = base64.b64decode(b64)
        binary = preprocess_image(image_bytes)
        floor = run_ocr(binary)

        logger.info("OCR result: '%s'", floor)
        return jsonify({"floor": floor})

    except Exception as exc:
        logger.exception("Scan failed: %s", exc)
        return jsonify({"error": str(exc), "floor": ""}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)